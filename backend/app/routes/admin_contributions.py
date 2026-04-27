"""Phase 4b — admin endpoints for per-contribution revert.

POST /api/admin/contributions/{id}/revert
    Roll back a single previously-approved contribution. Surgical inverse of
    the approval merge: deletes positions the contribution added (gap-fill)
    and restores positions it overwrote (region/overwrite — Phase 2).

Gating
------
* Hidden behind the ``per_contribution_revert`` feature flag (404 when off).
* Admin-only (env-var ``ADMIN_API_KEY``).
* Rejects if the contribution is older than ``REVERT_WINDOW_DAYS`` days,
  or was approved without undo capture (``revert_supported = false``),
  or is not currently in ``approved`` status.
* Acquires the global ``map_lock`` so no approve / restore can race the
  revert. Returns 423 if another mutation is in progress.

Cascading conflict logic
------------------------
Gap-fill uses ``INSERT OR IGNORE`` so a *later* gap-fill contribution
targeting an already-filled position never claims it. The only later
mutation that can collide is a Phase-2 region-overwrite contribution that
overlapped the same area; the helper
``database.list_later_region_overwrites`` returns those rows and their
``replaced.db`` defines the position set to subtract from both DELETE
and RESTORE steps. Today (Phase 2 not yet shipped) the helper returns
``[]`` so reverts always run the simple path.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import struct
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Optional, Set

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from ..auth import require_admin
from ..config import settings
from ..core import accounts_db, database as db
from ..core import feature_flags as ff
from ..core import r2_storage
from ..core.mapdb import RESOLUTION_LEVELS
from ..tasks.generate_map_levels import start_job as start_map_generation_job


logger = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/admin/contributions", tags=["admin-contributions"])

MAPPIECE_TABLE = "mappiece"
_DELETE_BATCH = 500


def _require_flag(flag: str) -> None:
    if not ff.is_feature_enabled(flag):
        raise HTTPException(status_code=404, detail="Not Found")


def _read_added_positions(local_path: str) -> Set[int]:
    """Decode the ``undo/<id>.added.bin`` blob into a position set."""
    out: Set[int] = set()
    with open(local_path, "rb") as f:
        while True:
            chunk = f.read(8 * 4096)
            if not chunk:
                break
            # Defensive: ignore any trailing partial qword.
            n = len(chunk) - (len(chunk) % 8)
            for i in range(0, n, 8):
                out.add(struct.unpack_from("<Q", chunk, i)[0])
    return out


def _build_conflict_set(cid: str, affected_bounds: Optional[tuple]) -> Set[int]:
    """Positions that later region-overwrite contributions now own.

    Today this is always empty (Phase 2 not shipped) but the implementation
    is here so the cascading logic does not need a follow-up patch when
    Phase 2 lands.
    """
    later = db.list_later_region_overwrites(cid, affected_bounds)
    if not later:
        return set()
    conflict: Set[int] = set()
    for row in later:
        replaced_key = r2_storage.undo_replaced_key(row["id"])
        if not r2_storage.object_exists(replaced_key):
            continue
        fd, tmp = tempfile.mkstemp(suffix=".replaced.db")
        os.close(fd)
        try:
            r2_storage.download_to_path(replaced_key, tmp)
            conn = sqlite3.connect(tmp)
            try:
                for (pos,) in conn.execute(f"SELECT position FROM {MAPPIECE_TABLE}"):
                    conflict.add(int(pos))
            finally:
                conn.close()
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    return conflict


@router.post("/{contribution_id}/revert")
async def revert_contribution(
    contribution_id: str,
    api_key: str = Depends(require_admin),
):
    _require_flag("per_contribution_revert")

    meta = db.get_contribution(contribution_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Contribution not found")
    if meta.get("status") != "approved":
        raise HTTPException(
            status_code=409,
            detail=f"Contribution is not approved (current status: {meta.get('status')})",
        )
    if not meta.get("revert_supported"):
        raise HTTPException(
            status_code=409,
            detail="This contribution was not captured for revert. Use a backup restore instead.",
        )

    approved_at = meta.get("approved_at")
    if approved_at is None:
        raise HTTPException(status_code=409, detail="Contribution has no approval timestamp")
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.REVERT_WINDOW_DAYS)
    if approved_at < cutoff:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Contribution is older than the {settings.REVERT_WINDOW_DAYS}-day "
                "revert window. Restore from a backup instead."
            ),
        )

    added_key = r2_storage.undo_added_key(contribution_id)
    if not r2_storage.object_exists(added_key):
        raise HTTPException(
            status_code=410,
            detail="Undo data is missing in object storage — revert is no longer possible.",
        )

    # Phase 0a — global mutex around any combined-DB mutation.
    try:
        lock_token = db.acquire_map_lock("revert")
    except db.MapLocked as exc:
        return JSONResponse(status_code=423, content={"detail": str(exc)})

    affected_bounds = None
    if meta.get("affected_min_x") is not None:
        affected_bounds = (
            meta["affected_min_x"],
            meta["affected_max_x"],
            meta["affected_min_z"],
            meta["affected_max_z"],
        )

    deleted_count = 0
    restored_count = 0
    combined_total = 0

    try:
        # 1) Pull the undo blobs locally.
        added_fd, added_tmp = tempfile.mkstemp(suffix=".added.bin")
        os.close(added_fd)
        replaced_tmp: Optional[str] = None
        combined_tmp: Optional[str] = None
        try:
            r2_storage.download_to_path(added_key, added_tmp)
            added_positions = _read_added_positions(added_tmp)

            replaced_key = r2_storage.undo_replaced_key(contribution_id)
            has_replaced = (
                int(meta.get("revert_replaced_count") or 0) > 0
                and r2_storage.object_exists(replaced_key)
            )
            if has_replaced:
                rfd, replaced_tmp = tempfile.mkstemp(suffix=".replaced.db")
                os.close(rfd)
                r2_storage.download_to_path(replaced_key, replaced_tmp)

            conflict_set = _build_conflict_set(contribution_id, affected_bounds)

            # 2) Download the current combined DB.
            cfd, combined_tmp = tempfile.mkstemp(suffix=".db")
            os.close(cfd)
            try:
                r2_storage.download_to_path(r2_storage.COMBINED_DB_KEY, combined_tmp)
            except FileNotFoundError:
                raise HTTPException(
                    status_code=409,
                    detail="Combined map .db not found in storage",
                )

            conn = sqlite3.connect(combined_tmp)
            try:
                # Step A — undo additions (skip positions later contributions own).
                to_delete = [p for p in added_positions if p not in conflict_set]
                for i in range(0, len(to_delete), _DELETE_BATCH):
                    batch = to_delete[i:i + _DELETE_BATCH]
                    placeholders = ",".join("?" * len(batch))
                    cur = conn.execute(
                        f"DELETE FROM {MAPPIECE_TABLE} WHERE position IN ({placeholders})",
                        batch,
                    )
                    deleted_count += cur.rowcount or 0
                conn.commit()

                # Step B — restore overwrites (Phase 2 only — no-op today).
                if replaced_tmp:
                    safe = replaced_tmp.replace("'", "''")
                    conn.execute(f"ATTACH DATABASE '{safe}' AS undo")
                    try:
                        cur = conn.execute(
                            f"""SELECT position, data FROM undo.{MAPPIECE_TABLE}"""
                        )
                        rows = cur.fetchall()
                        for pos, data in rows:
                            if int(pos) in conflict_set:
                                continue
                            conn.execute(
                                f"INSERT OR REPLACE INTO {MAPPIECE_TABLE} "
                                f"(position, data) VALUES (?, ?)",
                                (int(pos), data),
                            )
                            restored_count += 1
                        conn.commit()
                    finally:
                        try:
                            conn.execute("DETACH DATABASE undo")
                        except sqlite3.OperationalError:
                            pass

                combined_total = conn.execute(
                    f"SELECT COUNT(*) FROM {MAPPIECE_TABLE}"
                ).fetchone()[0]
            finally:
                conn.close()

            # 3) Re-upload the modified combined DB and refresh caches.
            r2_storage.upload_file(combined_tmp, r2_storage.COMBINED_DB_KEY)
            from ..core.mapdb import get_map_stats_from_path
            db.set_tops_map_stats(get_map_stats_from_path(combined_tmp))
            db.set_cached_tile_count(combined_total)
        finally:
            for p in (added_tmp, replaced_tmp, combined_tmp):
                if p:
                    try:
                        os.unlink(p)
                    except OSError:
                        pass

        # 4) Mark the contribution as reverted.
        db.mark_reverted(contribution_id, api_key)
    finally:
        db.release_map_lock(lock_token)

    # 5) Audit + partial regen.
    try:
        accounts_db.audit_log(
            api_key,
            "contribution.revert",
            target=contribution_id,
            metadata={
                "deleted": deleted_count,
                "restored": restored_count,
                "combined_total": combined_total,
                "affected_bounds": list(affected_bounds) if affected_bounds else None,
            },
        )
    except Exception:
        logger.exception("revert: audit log failed for %s", contribution_id)

    try:
        start_map_generation_job(
            sorted(RESOLUTION_LEVELS.keys()),
            affected_bounds=affected_bounds,
        )
    except Exception:
        logger.exception("revert: failed to enqueue regen for %s", contribution_id)

    return {
        "reverted": contribution_id,
        "deleted": deleted_count,
        "restored": restored_count,
        "combined_total": combined_total,
    }

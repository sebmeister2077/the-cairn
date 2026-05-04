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
        replaced_raw_key = r2_storage.undo_replaced_key(row["id"])
        fd, tmp = tempfile.mkstemp(suffix=".replaced.db")
        os.close(fd)
        try:
            try:
                r2_storage.download_artefact_to_raw_path(replaced_raw_key, tmp)
            except FileNotFoundError:
                continue
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


@router.post("/{contribution_id}/revert", status_code=202)
async def revert_contribution(
    contribution_id: str,
    api_key: str = Depends(require_admin),
):
    """Enqueue an asynchronous revert and return 202 immediately.

    The actual work — downloading the multi-GB combined DB, mutating it
    via SQLite, re-uploading to R2 — runs in
    :mod:`backend.app.tasks.revert_contribution`. The frontend polls
    ``/contribute/info`` to observe ``revert_status`` flip from ``queued``
    to ``running`` and finally to ``status='reverted'`` (or
    ``revert_status='failed'`` with ``revert_error`` populated).

    A backend restart mid-revert is recovered by the worker's
    ``kick_on_startup`` hook, which re-queues any rows left in
    ``revert_status='running'``. The merge holds the global ``map_lock``
    for its full duration so partial writes can't be observed by another
    worker.
    """
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

    # Reject if a revert is already queued or running for this row. We do
    # NOT reject the 'failed' state — re-queueing is the retry path.
    current = (meta.get("revert_status") or "").strip()
    if current in ("queued", "running"):
        raise HTTPException(
            status_code=409,
            detail=f"Revert already in progress for this contribution (state: {current})",
        )

    if not db.enqueue_revert(contribution_id, requested_by_key=api_key):
        # Race: someone else queued it between our SELECT and UPDATE.
        raise HTTPException(
            status_code=409,
            detail="Revert could not be queued — contribution state changed.",
        )

    # Audit the *intent* — the worker will audit the actual outcome with
    # the deleted/restored/combined_total counts.
    try:
        accounts_db.audit_log(
            api_key,
            "contribution.revert.queued",
            target=contribution_id,
            metadata={"queued_at": datetime.now(timezone.utc).isoformat()},
        )
    except Exception:
        logger.exception("revert: audit log (queue) failed for %s", contribution_id)

    # Wake the worker. Safe to call even if it's already running — it'll
    # be a no-op. Local import keeps the route module free of the worker
    # at import time.
    try:
        from ..tasks.revert_contribution import start_job
        start_job(contribution_id)
    except Exception:
        logger.exception("revert: failed to spawn worker for %s", contribution_id)

    return {
        "queued": contribution_id,
        "revert_status": "queued",
    }


# ---------------------------------------------------------------------------
# Worker-facing helpers
# ---------------------------------------------------------------------------

class RevertRetryable(Exception):
    """Raised by :func:`run_revert_merge` for transient failures the worker
    should retry (e.g. ``MapLocked``, network blip during R2 download)."""


class RevertFatal(Exception):
    """Raised by :func:`run_revert_merge` for permanent failures (missing
    undo blobs, contribution outside the revert window, etc.). The worker
    will not retry these."""


def run_revert_merge(contribution_id: str, requested_by_key: str = "") -> dict:
    """Execute one revert end-to-end. Called by the async worker.

    Holds the global ``map_lock`` for the full duration so concurrent
    approve / restore operations can't race. Idempotent under crash:
    the SQLite mutations on the downloaded combined DB are batched but
    the upload to R2 is the atomic commit point — if we crash before
    upload, the combined DB in R2 is unchanged and the worker simply
    re-claims the queued row on next startup.
    """
    api_key = requested_by_key or ""

    meta = db.get_contribution(contribution_id)
    if not meta:
        raise RevertFatal("Contribution not found")
    if meta.get("status") != "approved":
        raise RevertFatal(
            f"Contribution is not approved (current status: {meta.get('status')})"
        )
    if not meta.get("revert_supported"):
        raise RevertFatal(
            "This contribution was not captured for revert. Use a backup restore instead."
        )

    approved_at = meta.get("approved_at")
    if approved_at is None:
        raise RevertFatal("Contribution has no approval timestamp")
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.REVERT_WINDOW_DAYS)
    if approved_at < cutoff:
        raise RevertFatal(
            f"Contribution is older than the {settings.REVERT_WINDOW_DAYS}-day "
            "revert window. Restore from a backup instead."
        )

    added_key = r2_storage.undo_added_key(contribution_id)
    if not r2_storage.object_exists(added_key):
        raise RevertFatal(
            "Undo data is missing in object storage — revert is no longer possible."
        )

    # Phase 0a — global mutex around any combined-DB mutation. Treat
    # MapLocked as retryable: another mutation is in progress and ours
    # should re-queue rather than fail permanently.
    try:
        lock_token = db.acquire_map_lock("revert")
    except db.MapLocked as exc:
        raise RevertRetryable(str(exc))

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
                and (
                    r2_storage.object_exists(replaced_key)
                    or r2_storage.object_exists(replaced_key + ".zst")
                )
            )
            if has_replaced:
                rfd, replaced_tmp = tempfile.mkstemp(suffix=".replaced.db")
                os.close(rfd)
                r2_storage.download_artefact_to_raw_path(replaced_key, replaced_tmp)

            conflict_set = _build_conflict_set(contribution_id, affected_bounds)

            # 2) Download the current combined DB.
            cfd, combined_tmp = tempfile.mkstemp(suffix=".db")
            os.close(cfd)
            try:
                r2_storage.download_to_path(r2_storage.COMBINED_DB_KEY, combined_tmp)
            except FileNotFoundError:
                raise RevertFatal("Combined map .db not found in storage")

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

                # Reclaim the free pages left behind by the DELETE/INSERT
                # batches above. Without this, the combined .db re-uploaded
                # to R2 keeps its pre-revert physical size (the deleted
                # rows become empty pages, but SQLite never shrinks the
                # file on its own). That bloats both the raw R2 object
                # and the .zst sibling produced by ``schedule_combined_compress``.
                # VACUUM rewrites the file in place; safe inside the map
                # lock because no other writer can touch the combined DB.
                if deleted_count > 0 or restored_count > 0:
                    conn.isolation_level = None  # VACUUM cannot run in a transaction
                    try:
                        conn.execute("VACUUM")
                    finally:
                        conn.isolation_level = ""
            finally:
                conn.close()

            # 3) Re-upload the modified combined DB and refresh caches.
            r2_storage.upload_file(combined_tmp, r2_storage.COMBINED_DB_KEY)
            try:
                from .contribute_r2 import invalidate_combined_db_cache
                invalidate_combined_db_cache()
            except Exception:
                pass
            # Hand a private copy of the merged file to the async
            # compression worker so a fresh .zst sibling is produced.
            # Best-effort — the raw upload above is the source of truth.
            try:
                from ..tasks.compress_workers import schedule_combined_compress
                fresh_etag = r2_storage.get_object_etag(r2_storage.COMBINED_DB_KEY)
                handoff_fd, handoff_path = tempfile.mkstemp(suffix=".db")
                os.close(handoff_fd)
                import shutil as _shutil
                _shutil.copyfile(combined_tmp, handoff_path)
                schedule_combined_compress(handoff_path, fresh_etag)
            except Exception:
                pass
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
        # Clear the queue bookkeeping so the row no longer reads as
        # ``revert_status='running'`` to /info viewers.
        try:
            db.clear_revert_state(contribution_id)
        except Exception:
            logger.exception(
                "revert: failed to clear revert_state for %s", contribution_id
            )
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
        from ..core.feature_flags import is_auto_regen_after_approval_enabled
        if is_auto_regen_after_approval_enabled():
            start_map_generation_job(
                sorted(RESOLUTION_LEVELS.keys()),
                affected_bounds=affected_bounds,
            )
        else:
            logger.info(
                "revert: auto_regen_after_approval is OFF — skipping "
                "map-cache regen for %s", contribution_id,
            )
    except Exception:
        logger.exception("revert: failed to enqueue regen for %s", contribution_id)

    return {
        "reverted": contribution_id,
        "deleted": deleted_count,
        "restored": restored_count,
        "combined_total": combined_total,
    }

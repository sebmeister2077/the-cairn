"""Phase 4a — admin endpoints for the weekly-backup system.

GET    /api/admin/backups               — list scheduled + manual snapshots
POST   /api/admin/backups/create        — force-create a manual snapshot now
POST   /api/admin/backups/restore       — restore the combined map from a snapshot (TOTP-gated)
POST   /api/admin/backups/cleanup-now   — run retention sweep on demand (debug)

All endpoints require the env-var admin key. Restore additionally requires:
  * the ``backup_restore`` feature flag enabled (else 404, hidden)
  * a valid TOTP code in the body (else 401 ``totp_required``/``invalid_totp``)
  * the global map lock free (else 423 ``MapLocked``)
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .. import auth as _auth
from ..auth import require_admin
from ..core import accounts_db, database as db
from ..core import feature_flags as ff
from ..core import r2_storage
from ..core.mapdb import RESOLUTION_LEVELS, get_map_stats_from_path
from ..tasks import weekly_backup
from ..tasks.generate_map_levels import start_job as start_map_generation_job


logger = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/admin/backups", tags=["admin-backups"])


class RestoreBody(BaseModel):
    key: str
    confirm: bool = False
    totp_code: Optional[str] = None


def _require_flag(flag: str) -> None:
    """Hide the feature behind 404 when the flag is off (per Phase 0b)."""
    if not ff.is_feature_enabled(flag):
        raise HTTPException(status_code=404, detail="Not Found")


@router.get("")
async def list_backups(_: str = Depends(require_admin)):
    _require_flag("weekly_backups")
    return {
        "backups": weekly_backup.list_backups(),
        "retention": {
            "scheduled": _auth.settings.BACKUP_KEEP_SCHEDULED,
            "manual": _auth.settings.BACKUP_KEEP_MANUAL,
        },
    }


@router.post("/create")
async def create_backup(api_key: str = Depends(require_admin)):
    _require_flag("weekly_backups")

    # Hold the global map lock so an approve/revert can't overwrite the source
    # midway through our multipart copy (which would yield a corrupt backup).
    try:
        lock_token = db.acquire_map_lock("backup")
    except db.MapLocked as exc:
        return JSONResponse(status_code=423, content={"detail": str(exc)})

    try:
        # The R2 multipart copy can take many seconds for a multi-GB DB. Run it
        # in a worker thread so the event loop keeps serving other requests.
        try:
            key = await asyncio.to_thread(weekly_backup.create_manual_snapshot)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
    finally:
        db.release_map_lock(lock_token)

    accounts_db.audit_log(
        api_key, "map.create_backup", target=key, metadata={"kind": "manual"},
    )
    # Run cleanup so the new manual snapshot doesn't push us over the cap
    # silently — the admin sees the trim outcome on the next list.
    try:
        await asyncio.to_thread(weekly_backup.cleanup_old_backups)
    except Exception:
        logger.exception("backups: post-create cleanup failed")
    return {"created": key}


@router.post("/cleanup-now")
async def cleanup_now(_: str = Depends(require_admin)):
    _require_flag("weekly_backups")
    return await asyncio.to_thread(weekly_backup.cleanup_old_backups)


@router.post("/restore")
async def restore_backup(body: RestoreBody, api_key: str = Depends(require_admin)):
    _require_flag("backup_restore")

    if not body.confirm:
        raise HTTPException(
            status_code=400,
            detail={"code": "confirm_required", "message": "confirm=true is required"},
        )

    # Validate the requested key actually points at a backup we manage.
    if not body.key.startswith(r2_storage.BACKUP_KEY_PREFIX):
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_backup_key", "message": "Key is not a backup"},
        )
    available = {b["key"]: b for b in weekly_backup.list_backups()}
    backup = available.get(body.key)
    if backup is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "backup_not_found", "message": "Backup does not exist"},
        )

    # TOTP gate (Phase 4a step 6) — bubbles up structured 401/429 codes.
    _auth.require_totp(api_key, body.totp_code)

    # Acquire the global map lock so no approve/revert can race the restore.
    try:
        lock_token = db.acquire_map_lock("restore")
    except db.MapLocked as exc:
        return JSONResponse(status_code=423, content={"detail": str(exc)})

    backup_taken_at = backup.get("last_modified")
    # backup["last_modified"] from list_backups() is an ISO string; parse back.
    if isinstance(backup_taken_at, str):
        try:
            backup_taken_at = datetime.fromisoformat(backup_taken_at)
        except ValueError:
            backup_taken_at = None
    if backup_taken_at is None:
        backup_taken_at = datetime.now(timezone.utc)

    try:
        # 1) R2 server-side copy backup -> globalservermap.db (atomic, no download).
        r2_storage.copy_object(body.key, r2_storage.COMBINED_DB_KEY)

        # Drop the local cached copy so subsequent previews / regen pull the
        # restored bytes instead of the pre-restore version.
        try:
            from .contribute_r2 import invalidate_combined_db_cache
            invalidate_combined_db_cache()
        except Exception:
            pass

        # 2) Refresh stats from the restored DB. Pull a fresh copy to a temp
        #    file so we never serve stats inferred from the in-flight upload.
        tmp_path = None
        try:
            fd, tmp_path = tempfile.mkstemp(suffix=".db")
            os.close(fd)
            r2_storage.download_to_path(r2_storage.COMBINED_DB_KEY, tmp_path)
            stats = get_map_stats_from_path(tmp_path)
            db.set_tops_map_stats(stats)
            db.set_cached_tile_count(int(stats.get("tile_count", 0)))
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

        # 3) Mark contributions approved AFTER the snapshot as orphaned.
        orphaned = db.mark_contributions_orphaned_by_restore(backup_taken_at)
    finally:
        db.release_map_lock(lock_token)

    # 4) Audit + notify (banner is surfaced via /admin/backups/last-restore).
    accounts_db.audit_log(
        api_key,
        "map.restore_backup",
        target=body.key,
        metadata={
            "totp_verified": True,
            "backup_taken_at": backup_taken_at.isoformat() if hasattr(backup_taken_at, "isoformat") else None,
            "orphaned_contributions": orphaned,
        },
    )
    db.set_state(_LAST_RESTORE_KEY, _serialize_last_restore(api_key, body.key, orphaned))

    # 5) Kick a full TOPS regen — the restored map may differ everywhere.
    try:
        start_map_generation_job(sorted(RESOLUTION_LEVELS.keys()), affected_bounds=None)
    except Exception:
        logger.exception("restore: failed to enqueue regen")

    return {
        "restored_from": body.key,
        "orphaned_contributions": orphaned,
        "backup_taken_at": backup_taken_at.isoformat() if hasattr(backup_taken_at, "isoformat") else None,
    }


# ---------------------------------------------------------------------------
# Last-restore banner — admins see this for 7 days after any restore.
# ---------------------------------------------------------------------------

import json

_LAST_RESTORE_KEY = "last_backup_restore"
_LAST_RESTORE_BANNER_DAYS = 7


def _serialize_last_restore(admin_key: str, backup_key: str, orphaned: int) -> str:
    return json.dumps(
        {
            "admin_key_suffix": admin_key[-6:] if admin_key else "",
            "backup_key": backup_key,
            "restored_at": datetime.now(timezone.utc).isoformat(),
            "orphaned_contributions": orphaned,
        }
    )


@router.get("/last-restore")
async def last_restore(_: str = Depends(require_admin)):
    raw = db.get_state(_LAST_RESTORE_KEY)
    if not raw:
        return {"last_restore": None}
    try:
        info = json.loads(raw)
    except json.JSONDecodeError:
        return {"last_restore": None}
    # Surface only if recent enough to still warrant the banner.
    try:
        ts = datetime.fromisoformat(info.get("restored_at"))
    except (ValueError, TypeError):
        return {"last_restore": None}
    age_days = (datetime.now(timezone.utc) - ts).total_seconds() / 86400
    if age_days > _LAST_RESTORE_BANNER_DAYS:
        return {"last_restore": None}
    return {"last_restore": info}

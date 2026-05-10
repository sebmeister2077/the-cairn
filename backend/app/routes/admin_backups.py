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
import secrets
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
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


def _do_restore_blocking(backup_key: str, backup_taken_at: datetime) -> int:
    """Synchronous body of the restore flow.

    Performs R2 copy/upload, decompression, stat refresh, and orphan marking.
    Designed to be called via ``asyncio.to_thread`` so it does not block the
    event loop. Returns the number of orphaned contributions.
    """
    # 1) Promote the backup into ``globalservermap.db``. When the chosen
    #    backup is already raw, R2's server-side copy is the fastest option
    #    (atomic, no egress). For ``.zst`` snapshots we download → decompress
    #    to a temp → upload the raw bytes.
    if backup_key.endswith(".zst"):
        from ..core import compression as comp
        zst_fd, zst_path = tempfile.mkstemp(suffix=".db.zst")
        os.close(zst_fd)
        raw_fd, raw_path = tempfile.mkstemp(suffix=".db")
        os.close(raw_fd)
        try:
            r2_storage.download_to_path(backup_key, zst_path)
            comp.decompress_file(zst_path, raw_path)
            r2_storage.upload_file(raw_path, r2_storage.COMBINED_DB_KEY)
        finally:
            for p in (zst_path, raw_path):
                try:
                    os.unlink(p)
                except OSError:
                    pass
    else:
        r2_storage.copy_object(backup_key, r2_storage.COMBINED_DB_KEY)

    # Drop the local cached copy so subsequent previews / regen pull the
    # restored bytes instead of the pre-restore version.
    try:
        from .contribute_r2 import invalidate_combined_db_cache
        invalidate_combined_db_cache()
    except Exception:
        pass

    # 2) Refresh stats from the restored DB. Pull a fresh copy to a temp file
    #    so we never serve stats inferred from the in-flight upload.
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
    return db.mark_contributions_orphaned_by_restore(backup_taken_at)


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
        # Steps 1–3 perform blocking R2 + SQLite work. Run them off the event
        # loop so other requests aren't starved while a restore is in flight.
        orphaned = await asyncio.to_thread(
            _do_restore_blocking, body.key, backup_taken_at
        )
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


# ---------------------------------------------------------------------------
# Shareable backup download links
# ---------------------------------------------------------------------------

# Allowed TTLs for /download-links. Kept small + closed so admins can't mint a
# link with an arbitrary lifetime.
_DOWNLOAD_LINK_TTLS_SECONDS = {
    900,         # 15 min
    3600,        # 1 hour
    86400,       # 24 hours
    7 * 86400,   # 7 days
    30 * 86400,  # 30 days
}

_LABEL_MAX_LEN = 200


class CreateDownloadLinkBody(BaseModel):
    key: str
    ttl_seconds: int
    label: Optional[str] = None


def _shareable_url(request: Request, token: str) -> str:
    """Build the public URL recipients use to redeem a token."""
    base = _auth.settings.PUBLIC_BASE_URL or str(request.base_url).rstrip("/")
    return f"{base}/api/public/backup-download/{token}"


def _serialize_link(link: dict, *, request: Optional[Request] = None) -> dict:
    """Convert a DB row + redemption stats into a JSON-friendly dict."""
    now = datetime.now(timezone.utc)
    expires_at = link.get("expires_at")
    revoked_at = link.get("revoked_at")
    if revoked_at is not None:
        status = "revoked"
    elif expires_at is not None and expires_at <= now:
        status = "expired"
    else:
        status = "active"
    out = {
        "id": link["id"],
        "token": link["token"],
        "backup_key": link["backup_key"],
        "label": link.get("label"),
        "created_by_suffix": (str(link.get("created_by_key_id") or ""))[-6:],
        "created_at": link["created_at"].isoformat() if link.get("created_at") else None,
        "expires_at": expires_at.isoformat() if expires_at else None,
        "revoked_at": revoked_at.isoformat() if revoked_at else None,
        "revoked_by_suffix": (str(link.get("revoked_by_key_id") or ""))[-6:] if link.get("revoked_by_key_id") else None,
        "redeem_count": int(link.get("redeem_count") or 0),
        "success_count": int(link.get("success_count") or 0),
        "last_redeem_at": (
            link["last_redeem_at"].isoformat() if link.get("last_redeem_at") else None
        ),
        "status": status,
    }
    if request is not None:
        out["url"] = _shareable_url(request, link["token"])
    return out


@router.post("/download-links")
async def create_download_link(
    body: CreateDownloadLinkBody,
    request: Request,
    api_key: str = Depends(require_admin),
):
    _require_flag("weekly_backups")

    if body.ttl_seconds not in _DOWNLOAD_LINK_TTLS_SECONDS:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "invalid_ttl",
                "message": "ttl_seconds must be one of "
                + ", ".join(str(t) for t in sorted(_DOWNLOAD_LINK_TTLS_SECONDS)),
            },
        )

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

    label = (body.label or "").strip() or None
    if label and len(label) > _LABEL_MAX_LEN:
        label = label[:_LABEL_MAX_LEN]

    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=body.ttl_seconds)

    row = accounts_db.create_backup_download_link(
        token=token,
        backup_key=body.key,
        created_by=api_key,
        expires_at=expires_at,
        label=label,
    )
    accounts_db.audit_log(
        api_key,
        "map.create_backup_download_link",
        target=body.key,
        metadata={
            "link_id": row["id"],
            "ttl_seconds": body.ttl_seconds,
            "label": label,
        },
    )

    payload = _serialize_link(row, request=request)
    payload["size"] = backup.get("size")
    return payload


@router.get("/download-links")
async def list_download_links(
    request: Request,
    _: str = Depends(require_admin),
):
    _require_flag("weekly_backups")
    rows = accounts_db.list_backup_download_links()
    return {"links": [_serialize_link(r, request=request) for r in rows]}


@router.get("/download-links/{link_id}/redemptions")
async def list_link_redemptions(
    link_id: int,
    _: str = Depends(require_admin),
):
    _require_flag("weekly_backups")
    if not accounts_db.get_backup_download_link(link_id):
        raise HTTPException(status_code=404, detail="link_not_found")
    rows = accounts_db.list_backup_download_redemptions(link_id)
    return {
        "redemptions": [
            {
                "id": r["id"],
                "redeemed_at": r["redeemed_at"].isoformat() if r.get("redeemed_at") else None,
                "ip_hash_short": (r.get("ip_hash") or "")[:12] or None,
                "user_agent": r.get("user_agent"),
                "success": bool(r.get("success")),
                "failure_reason": r.get("failure_reason"),
            }
            for r in rows
        ]
    }


@router.delete("/download-links/{link_id}")
async def revoke_download_link(link_id: int, api_key: str = Depends(require_admin)):
    _require_flag("weekly_backups")
    existing = accounts_db.get_backup_download_link(link_id)
    if not existing:
        raise HTTPException(status_code=404, detail="link_not_found")
    updated = accounts_db.revoke_backup_download_link(link_id, api_key)
    if updated is None:
        # Already revoked — return current row, idempotent.
        return {"revoked": False, "link": _serialize_link(existing)}
    accounts_db.audit_log(
        api_key,
        "map.revoke_backup_download_link",
        target=existing.get("backup_key"),
        metadata={"link_id": link_id},
    )
    return {"revoked": True, "link": _serialize_link(updated)}

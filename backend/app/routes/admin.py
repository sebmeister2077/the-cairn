"""Admin endpoints for dynamic API key management.

All routes require the ADMIN_API_KEY env-var key via the require_admin dependency.

GET    /api/admin/keys                   — list all keys
POST   /api/admin/keys                   — create a new key
DELETE /api/admin/keys/{key_id}          — revoke a key
GET    /api/admin/invite-links           — list all invite links
POST   /api/admin/invite-links           — create a new invite link
DELETE /api/admin/invite-links/{token}   — revoke an invite link
"""

import secrets
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..auth import require_admin
from ..core import database as db
from ..core import generation_tracker, r2_storage
from ..core.mapdb import RESOLUTION_LEVELS
from ..tasks.generate_map_levels import (
    is_job_running,
    is_stop_requested,
    request_stop,
    start_job,
)

router = APIRouter()

VALID_PERMISSIONS = {"read", "contribute"}


class CreateKeyRequest(BaseModel):
    name: str
    permissions: str = "read"
    consume_once: bool = False


class CreateInviteLinkRequest(BaseModel):
    name: str
    permissions: str = "read"
    max_uses: Optional[int] = None       # None = unlimited
    expires_in_hours: Optional[int] = None  # None = never expires


def _serialise(record: dict) -> dict:
    """Convert datetimes to ISO strings and mask the raw key for list views."""
    out = dict(record)
    for field in ("created_at", "last_used_at"):
        val = out.get(field)
        if val and hasattr(val, "isoformat"):
            out[field] = val.isoformat()
    return out


@router.get("/admin/keys")
async def list_keys(
    _: str = Depends(require_admin),
    status: str = Query("all", pattern="^(all|active|revoked)$"),
    q: str = Query("", max_length=128),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
) -> dict:
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    page = db.list_api_keys_paginated(status=status, q=q.strip(), offset=offset, limit=limit)
    return {
        "items": [_serialise(r) for r in page["items"]],
        "total": page["total"],
        "next_offset": (offset + limit) if offset + limit < page["total"] else None,
    }


@router.post("/admin/keys", status_code=201)
async def create_key(
    body: CreateKeyRequest,
    _: str = Depends(require_admin),
) -> dict:
    if body.permissions not in VALID_PERMISSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"permissions must be one of: {', '.join(sorted(VALID_PERMISSIONS))}",
        )
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="name is required")

    key = secrets.token_urlsafe(32)
    record = db.create_api_key(key, body.name.strip(), body.permissions, body.consume_once)
    return _serialise(record)


@router.delete("/admin/keys/{key_id}", status_code=204)
async def revoke_key(key_id: str, _: str = Depends(require_admin)):
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    record = db.get_api_key(key_id)
    if not record:
        raise HTTPException(status_code=404, detail="Key not found")
    db.revoke_api_key(key_id)
    return JSONResponse(status_code=204, content=None)


def _serialise_invite(record: dict) -> dict:
    out = dict(record)
    for field in ("created_at", "expires_at"):
        val = out.get(field)
        if val and hasattr(val, "isoformat"):
            out[field] = val.isoformat()
    return out


@router.get("/admin/invite-links")
async def list_invite_links(
    _: str = Depends(require_admin),
    status: str = Query("all", pattern="^(all|active|revoked)$"),
    q: str = Query("", max_length=128),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
) -> dict:
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    page = db.list_invite_links_paginated(status=status, q=q.strip(), offset=offset, limit=limit)
    return {
        "items": [_serialise_invite(r) for r in page["items"]],
        "total": page["total"],
        "next_offset": (offset + limit) if offset + limit < page["total"] else None,
    }


@router.post("/admin/invite-links", status_code=201)
async def create_invite_link(
    body: CreateInviteLinkRequest,
    _: str = Depends(require_admin),
) -> dict:
    if body.permissions not in VALID_PERMISSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"permissions must be one of: {', '.join(sorted(VALID_PERMISSIONS))}",
        )
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="name is required")
    if body.max_uses is not None and body.max_uses < 1:
        raise HTTPException(status_code=400, detail="max_uses must be at least 1")

    expires_at = None
    if body.expires_in_hours is not None and body.expires_in_hours > 0:
        expires_at = datetime.now(timezone.utc) + timedelta(hours=body.expires_in_hours)

    token = secrets.token_urlsafe(20)
    record = db.create_invite_link(
        token=token,
        name=body.name.strip(),
        permissions=body.permissions,
        max_uses=body.max_uses,
        expires_at=expires_at,
    )
    return _serialise_invite(record)


@router.delete("/admin/invite-links/{token}", status_code=204)
async def revoke_invite_link(token: str, _: str = Depends(require_admin)):
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    record = db.get_invite_link(token)
    if not record:
        raise HTTPException(status_code=404, detail="Invite link not found")
    db.revoke_invite_link(token)
    return JSONResponse(status_code=204, content=None)


@router.get("/admin/invite-links/{token}/keys")
async def list_invite_link_keys(
    token: str,
    _: str = Depends(require_admin),
) -> List[dict]:
    """Return every API key minted from this invite link, joined with the
    user account (if any) bound to that key.
    """
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    record = db.get_invite_link(token)
    if not record:
        raise HTTPException(status_code=404, detail="Invite link not found")
    rows = db.list_api_keys_by_invite(token)
    out = []
    for r in rows:
        item = _serialise(r)
        for field in ("user_joined_at", "user_deleted_at"):
            val = item.get(field)
            if val and hasattr(val, "isoformat"):
                item[field] = val.isoformat()
        out.append(item)
    return out


# ---------------------------------------------------------------------------
# TOPS map multi-resolution generation
# ---------------------------------------------------------------------------

class GenerateMapLevelsRequest(BaseModel):
    levels: Optional[List[int]] = None  # None = all configured levels
    affected_bounds: Optional[dict] = None  # {min_x, max_x, min_z, max_z} world blocks


def _generation_status_payload() -> dict:
    status = generation_tracker.get_status()
    try:
        queue_size = db.regen_queue_size()
    except Exception:
        queue_size = 0
    return {
        "levels": status.get("levels", {}),
        "configured_levels": [
            {"level": lvl, "max_dimension": dim}
            for lvl, dim in sorted(RESOLUTION_LEVELS.items())
        ],
        "is_running": is_job_running(),
        "stop_requested": is_stop_requested(),
        "queued_requests": queue_size,
    }


@router.get("/admin/tops-map/generation-status")
async def get_map_generation_status(_: str = Depends(require_admin)):
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    return _generation_status_payload()


@router.post("/admin/tops-map/generate", status_code=202)
async def request_map_generation(
    body: GenerateMapLevelsRequest,
    _: str = Depends(require_admin),
):
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")

    levels = body.levels or list(RESOLUTION_LEVELS.keys())
    invalid = [lvl for lvl in levels if lvl not in RESOLUTION_LEVELS]
    if invalid:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown level(s): {invalid}. Valid: {list(RESOLUTION_LEVELS)}",
        )

    bounds_tuple = None
    if body.affected_bounds:
        try:
            bounds_tuple = (
                int(body.affected_bounds["min_x"]),
                int(body.affected_bounds["max_x"]),
                int(body.affected_bounds["min_z"]),
                int(body.affected_bounds["max_z"]),
            )
        except (KeyError, TypeError, ValueError):
            raise HTTPException(
                status_code=400,
                detail="affected_bounds must include integer min_x/max_x/min_z/max_z",
            )

    # Always enqueue. If a worker is already running, the request will be
    # drained by it before it exits; if not, ``start_job`` spawns a fresh one.
    accepted = start_job(sorted(set(levels)), affected_bounds=bounds_tuple)
    if not accepted:
        raise HTTPException(status_code=500, detail="Could not enqueue generation request")

    return _generation_status_payload()


@router.post("/admin/tops-map/stop", status_code=202)
async def stop_map_generation(_: str = Depends(require_admin)):
    """Cooperative stop: signal the generation worker to abort after the
    current chunk finishes.

    Any queued (but not-yet-started) regen requests are discarded so the
    worker doesn't immediately resume the work the admin just asked to
    stop. The currently-rendering level is marked as failed with a
    "Stopped by admin" message; subsequent levels in the same plan are
    skipped. To resume, hit the regular ``/admin/tops-map/generate``
    endpoint again — ``start_job`` clears the stop flag automatically.
    """
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    request_stop()
    return _generation_status_payload()


@router.delete("/admin/tops-map/level/{level}", status_code=204)
async def delete_map_level(level: int, _: str = Depends(require_admin)):
    """Wipe an entire resolution level's chunks + assembled image from R2.

    Useful for forcing a clean regeneration.
    """
    if level not in RESOLUTION_LEVELS:
        raise HTTPException(status_code=400, detail="Unknown level")
    if is_job_running():
        raise HTTPException(
            status_code=409,
            detail="Cannot delete level while generation is running",
        )

    prefix = f"cache/tops-map-level{level}/"
    keys = r2_storage.list_keys_with_prefix(prefix)
    keys.append(r2_storage.tops_map_level_assembled_key(level))
    r2_storage.delete_keys(keys)
    db.delete_chunk_urls_for_level(level)
    from . import tops_map_r2 as _tops_map_r2
    _tops_map_r2.invalidate_level_metadata_cache(level)
    generation_tracker.reset_level(level)
    return JSONResponse(status_code=204, content=None)

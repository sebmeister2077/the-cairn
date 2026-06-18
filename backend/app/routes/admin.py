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
from ..core import grouping_library_db
from ..core.mapdb import RESOLUTION_LEVELS
from ..tasks.generate_map_levels import (
    activate_pending_version,
    delete_version_objects,
    is_job_running,
    is_stop_requested,
    refresh_level_metadata,
    request_stop,
    rollback_to_previous_version,
    start_job,
    write_level_pointer,
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


@router.get("/admin/pending-counts")
async def pending_counts(_: str = Depends(require_admin)) -> dict:
    """Aggregated counts of admin queues that need review.

    Used by the frontend to badge nav items on entry so the admin sees at
    a glance whether anything is waiting. The endpoint stays cheap by
    issuing one ``COUNT(*)`` per queue rather than fetching rows.
    """
    if not db.is_available():
        return {
            "map_contributions": 0,
            "landmark_renames": 0,
            "translocator_screenshots": 0,
            "grouping_reports": 0,
        }
    return {
        "map_contributions": db.count_pending_contributions(),
        "landmark_renames": db.count_landmark_edit_requests("pending"),
        "translocator_screenshots": db.count_tl_screenshot_requests("pending"),
        "grouping_reports": grouping_library_db.count_open_reports(),
    }


@router.get("/admin/keys")
async def list_keys(
    _: str = Depends(require_admin),
    status: str = Query("all", pattern="^(all|active|revoked)$"),
    q: str = Query("", max_length=128),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    sort: str = Query(
        "created_at",
        pattern="^(created_at|last_used_at|usage_count|bound_identity|name)$",
    ),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    bound_identity: str = Query("any", max_length=256),
) -> dict:
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    page = db.list_api_keys_paginated(
        status=status,
        q=q.strip(),
        offset=offset,
        limit=limit,
        sort=sort,
        order=order,
        bound_identity=bound_identity,
    )
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
    # Pre-existing rows from before the migration won't have this column in
    # the dict if a caller mocked the DB; default to False for safety.
    out["is_default_public"] = bool(out.get("is_default_public", False))
    return out


class UpdateInviteLinkRequest(BaseModel):
    is_default_public: bool


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


@router.patch("/admin/invite-links/{token}")
async def update_invite_link(
    token: str,
    body: UpdateInviteLinkRequest,
    _: str = Depends(require_admin),
) -> dict:
    """Toggle the ``is_default_public`` flag on an invite link.

    At most one link can be flagged at a time; setting it on one clears it
    on every other. Refuses to flag a revoked link.
    """
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    try:
        record = db.set_invite_link_default_public(token, body.is_default_public)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not record:
        raise HTTPException(status_code=404, detail="Invite link not found")
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


class RefreshMapMetadataRequest(BaseModel):
    levels: Optional[List[int]] = None  # None = all configured levels


class MarkLevelStatusRequest(BaseModel):
    status: str  # "complete" or "failed"
    error: Optional[str] = None  # required when status == "failed"


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


@router.post("/admin/tops-map/refresh-metadata", status_code=200)
async def refresh_map_metadata(
    body: RefreshMapMetadataRequest,
    _: str = Depends(require_admin),
):
    """Recompute and re-upload each level's ``metadata.json`` from the
    current ``combined.db`` *without* re-rendering any chunks.

    Use this to repair overlay misalignment when per-level metadata bounds
    drifted out of sync with the underlying tiles (e.g. a contribution
    landed mid-regen-pass and only some levels got the new geometry
    written). Runs synchronously — geometry compute is cheap because it
    only scans the ``mappiece`` index, not pixel data.

    Refuses to run while a full regeneration job is in flight to avoid
    racing the worker that's about to rewrite metadata itself.
    """
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    if is_job_running():
        raise HTTPException(
            status_code=409,
            detail="Cannot refresh metadata while generation is running",
        )

    if body.levels is not None:
        invalid = [lvl for lvl in body.levels if lvl not in RESOLUTION_LEVELS]
        if invalid:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown level(s): {invalid}. Valid: {list(RESOLUTION_LEVELS)}",
            )

    refreshed = refresh_level_metadata(body.levels)
    return {
        "refreshed": [
            {
                "level": lvl,
                "start_x": meta["start_x"],
                "start_z": meta["start_z"],
                "width_blocks": meta["width_blocks"],
                "height_blocks": meta["height_blocks"],
                "image_w": meta["image_w"],
                "image_h": meta["image_h"],
                "scale": meta["scale"],
            }
            for lvl, meta in sorted(refreshed.items())
        ],
    }


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
    keys.append(r2_storage.tops_map_level_pointer_key(level))
    r2_storage.delete_keys(keys)
    db.delete_chunk_urls_for_level(level)
    from . import tops_map_r2 as _tops_map_r2
    _tops_map_r2.invalidate_level_pointer_cache(level)
    generation_tracker.reset_level(level)
    return JSONResponse(status_code=204, content=None)


@router.post("/admin/tops-map/level/{level}/activate", status_code=200)
async def activate_map_level(level: int, _: str = Depends(require_admin)):
    """Promote a level's pending staged version to live.

    Activation is allowed even while a generation job is running for
    *other* levels — each level stages to its own version subprefix so
    pointer flips on level X cannot race with uploads to level Y. The
    only refusal is when the level being activated is itself currently
    being regenerated (its pending bundle could be the previous one,
    which is still safe to activate, but the tracker would immediately
    overwrite the status the activation just wrote).
    """
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    if level not in RESOLUTION_LEVELS:
        raise HTTPException(status_code=400, detail="Unknown level")
    level_status = generation_tracker.get_level_status(level).get("status")
    if level_status == "generating":
        raise HTTPException(
            status_code=409,
            detail=f"Cannot activate level {level} while it is being regenerated",
        )
    try:
        result = activate_pending_version(level)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    payload = _generation_status_payload()
    payload["activation"] = {"level": level, **result}
    return payload


@router.post("/admin/tops-map/activate-all", status_code=200)
async def activate_all_pending_map_levels(_: str = Depends(require_admin)):
    """Activate every level that currently has a pending staged version.

    Levels without a pending version are silently skipped. Levels that
    are themselves currently being regenerated are also skipped (and
    reported in ``skipped``) so the bulk activate doesn't fail outright
    just because one level is mid-render.
    """
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    activated = []
    skipped = []
    errors = []
    for level in sorted(RESOLUTION_LEVELS):
        if not generation_tracker.get_pending_version(level):
            continue
        if generation_tracker.get_level_status(level).get("status") == "generating":
            skipped.append({"level": level, "reason": "currently regenerating"})
            continue
        try:
            result = activate_pending_version(level)
        except RuntimeError as exc:
            errors.append({"level": level, "error": str(exc)})
            continue
        activated.append({"level": level, **result})
    payload = _generation_status_payload()
    payload["activations"] = activated
    payload["activation_skipped"] = skipped
    payload["activation_errors"] = errors
    return payload


@router.post("/admin/tops-map/level/{level}/rollback", status_code=200)
async def rollback_map_level(level: int, _: str = Depends(require_admin)):
    """Restore a level's previous live version (one-step undo of an activate).

    Allowed while other levels are being regenerated; refused only if
    this specific level is currently being regenerated.
    """
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    if level not in RESOLUTION_LEVELS:
        raise HTTPException(status_code=400, detail="Unknown level")
    if generation_tracker.get_level_status(level).get("status") == "generating":
        raise HTTPException(
            status_code=409,
            detail=f"Cannot rollback level {level} while it is being regenerated",
        )
    try:
        result = rollback_to_previous_version(level)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    payload = _generation_status_payload()
    payload["rollback"] = {"level": level, **result}
    return payload


@router.post("/admin/tops-map/level/{level}/mark", status_code=200)
async def mark_map_level_status(
    level: int,
    body: MarkLevelStatusRequest,
    _: str = Depends(require_admin),
):
    """Manually override a level's tracker status to ``complete`` or
    ``failed``.

    This only updates the status JSON in ``app_state`` — it does NOT touch
    the rendered chunks in R2. Useful when the worker has crashed or when
    heavy compute is OFF and an admin wants to clear a stale ``failed``
    badge so the UI stops showing the level as broken.
    """
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    if level not in RESOLUTION_LEVELS:
        raise HTTPException(status_code=400, detail="Unknown level")
    if is_job_running():
        raise HTTPException(
            status_code=409,
            detail="Cannot override level status while generation is running",
        )

    status = (body.status or "").strip().lower()
    if status == "complete":
        generation_tracker.mark_complete(level)
    elif status == "failed":
        msg = (body.error or "Marked failed manually by admin").strip()
        generation_tracker.mark_failed(level, msg)
    else:
        raise HTTPException(
            status_code=400,
            detail="status must be 'complete' or 'failed'",
        )
    return _generation_status_payload()

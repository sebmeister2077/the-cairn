"""Landmarks read + write endpoints (Phase 1 + 2 of the user-editable
landmarks plan).

Read path
---------
``GET /api/landmarks/url`` and ``GET /api/translocators/url`` return a
short-lived presigned URL for the live geojson hosted in R2. The frontend
fetches the bytes directly from R2 (no proxying through the backend).

Write path (landmarks only — translocator editing is out of scope for this
iteration)
---------------------------------------------------------------------------
``POST   /api/landmarks``                  — append a new landmark (live)
``PATCH  /api/landmarks/{id}``             — rename. Owner edits apply live;
                                              edits on someone-else's or
                                              seeded landmarks insert a
                                              pending edit-request instead
                                              of touching the file.
``GET    /api/landmarks/my-edit-requests`` — list the caller's pending /
                                              recently-resolved rename
                                              requests.

The geojson file in R2 is the single source of truth for what's rendered.
The DB tables ``landmarks_audit`` and ``landmark_edit_requests`` carry the
audit log + admin queue; see [backend/app/core/database.py].
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_active_user
from ..core import database as db
from ..core import r2_storage


logger = logging.getLogger("uvicorn.error")
router = APIRouter(tags=["landmarks"])

# 7 days — matches the AWS S3v4 maximum. ``generate_presigned_download_url``
# clamps anything larger to that maximum.
_PRESIGN_TTL_SECONDS = 7 * 24 * 60 * 60

# Single-process serialisation of read-modify-upload of the geojson file.
# The file is small (<1 MB), so the critical section is milliseconds.
# If the deployment ever scales out beyond one backend replica this
# becomes insufficient and needs a DB-backed advisory lock.
_landmarks_lock = asyncio.Lock()

# Allowed type values must mirror the frontend's ``LandmarkProperty.type`` union
# in [frontend/src/components/MapViewer.tsx]. Misc landmarks are filtered out
# from rendering but are valid storage values (kept for future visibility).
_ALLOWED_TYPES = {"Base", "Server", "Misc"}

# Coordinate sanity limits. The world is theoretically unbounded but a
# 4-million-block half-edge gives a generous safety net while still rejecting
# obvious fat-fingers / overflow attempts.
_COORD_LIMIT = 4_000_000
_Y_MIN = -1024
_Y_MAX = 1024

# Label is short user-controlled text. Allow newlines (existing seed data has
# them) and a generous length cap to discourage abuse / griefing.
_LABEL_MAX_LEN = 200

# "account_required" is the structured error the frontend uses to surface
# the create-account CTA. It mirrors the convention used by the registration
# kill-switch endpoint in [backend/app/routes/account.py].
_ACCOUNT_REQUIRED_DETAIL = {
    "code": "account_required",
    "message": "Create an account to add or rename landmarks.",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _presign(key: str) -> dict:
    if not r2_storage.object_exists(key):
        raise HTTPException(
            status_code=404,
            detail=f"R2 object not found: {key}. Run the migration script.",
        )
    url = r2_storage.generate_presigned_download_url(
        key,
        expires_seconds=_PRESIGN_TTL_SECONDS,
        content_type="application/geo+json",
        verify_exists=False,
    )
    etag = ""
    try:
        etag = r2_storage.get_object_etag(key)
    except Exception:
        pass
    return {
        "url": url,
        "etag": etag,
        "expires_in_seconds": int(_PRESIGN_TTL_SECONDS * 0.75),
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_landmarks_file() -> dict:
    """Download + parse the live landmarks.geojson from R2."""
    try:
        raw = r2_storage.download_bytes(r2_storage.landmarks_live_key())
    except FileNotFoundError:
        raise HTTPException(
            status_code=503,
            detail="landmarks.geojson missing from R2; run the migration script.",
        )
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        logger.exception("landmarks: failed to parse R2 file")
        raise HTTPException(status_code=500, detail=f"Corrupt landmarks file: {exc}")
    if not isinstance(data, dict) or not isinstance(data.get("features"), list):
        raise HTTPException(status_code=500, detail="Corrupt landmarks file (no features array)")
    return data


def _save_landmarks_file(data: dict) -> None:
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    key = r2_storage.landmarks_live_key()
    r2_storage.upload_bytes(key, body, content_type="application/geo+json")
    r2_storage.invalidate_presigned_download_url(key)


def _find_feature(data: dict, landmark_id: str) -> Optional[dict]:
    for feat in data["features"]:
        if isinstance(feat, dict) and (feat.get("properties") or {}).get("id") == landmark_id:
            return feat
    return None


def _normalise_label(raw: str) -> str:
    """Trim, collapse Windows line endings, and reject control chars other
    than tab/newline. Returns the canonical form to store."""
    if not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="label must be a string")
    s = raw.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not s:
        raise HTTPException(status_code=400, detail="label is empty")
    if len(s) > _LABEL_MAX_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"label is too long (max {_LABEL_MAX_LEN} chars)",
        )
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", s):
        raise HTTPException(status_code=400, detail="label contains invalid control characters")
    return s


def _require_account_user(ctx: dict) -> dict:
    """``require_active_user`` already 403s for keys with no users row, but the
    synthetic admin path returns ``user=None``. We require a real account row
    here so admin-without-account can't accidentally be recorded as the
    landmark owner. Admins acting on landmarks should use the admin endpoints
    in [backend/app/routes/admin_landmarks.py] (Phase 3)."""
    user = ctx.get("user")
    if user is None:
        raise HTTPException(status_code=403, detail=_ACCOUNT_REQUIRED_DETAIL)
    return user


def _ctx_api_key_id(ctx: dict) -> Optional[str]:
    """Return the ``api_keys.id`` UUID for the caller's API key.

    For DB-backed keys ``ctx['info']`` is a row dict from ``api_keys`` and
    contains ``id``. For env-var admin/legacy keys there is no DB row, so
    the audit columns receive None (the schema permits NULL).
    """
    info = ctx.get("info") or {}
    raw = info.get("id")
    return str(raw) if raw is not None else None


# ---------------------------------------------------------------------------
# Read endpoints
# ---------------------------------------------------------------------------

@router.get("/landmarks/url")
async def get_landmarks_url() -> dict:
    return _presign(r2_storage.landmarks_live_key())


@router.get("/translocators/url")
async def get_translocators_url() -> dict:
    return _presign(r2_storage.translocators_live_key())


# ---------------------------------------------------------------------------
# Write endpoints (landmarks only)
# ---------------------------------------------------------------------------

class AddLandmarkBody(BaseModel):
    # Max
    label: str
    type: str = Field(..., description="One of: Base | Server | Misc")
    x: int
    z: int
    y: Optional[int] = None


class RenameLandmarkBody(BaseModel):
    label: str


def _serialise_edit_request(row: dict) -> dict:
    created = row.get("created_at")
    reviewed = row.get("reviewed_at")
    return {
        "id": row["id"],
        "landmark_id": row["landmark_id"],
        "current_label": row["current_label"],
        "proposed_label": row["proposed_label"],
        "status": row["status"],
        "submitted_by_display_name": row["submitted_by_display_name"],
        "created_at": created.isoformat() if hasattr(created, "isoformat") else created,
        "reviewed_at": reviewed.isoformat() if hasattr(reviewed, "isoformat") else reviewed,
        "review_note": row.get("review_note"),
    }


@router.post("/landmarks")
async def add_landmark(
    payload: AddLandmarkBody,
    ctx: dict = Depends(require_active_user),
) -> dict:
    """Append a new user-added landmark to the live geojson file (live edit)."""
    user = _require_account_user(ctx)
    if payload.type not in _ALLOWED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"type must be one of {sorted(_ALLOWED_TYPES)}",
        )
    if abs(payload.x) > _COORD_LIMIT or abs(payload.z) > _COORD_LIMIT:
        raise HTTPException(status_code=400, detail="coordinates out of range")
    if payload.y is not None and not (_Y_MIN <= payload.y <= _Y_MAX):
        raise HTTPException(status_code=400, detail=f"y must be between {_Y_MIN} and {_Y_MAX}")
    label = _normalise_label(payload.label)

    landmark_id = str(uuid.uuid4())
    now = _now_iso()
    display_name = user.get("display_name") or "Anonymous"
    user_id = str(user["id"]) if user.get("id") is not None else None
    if not user_id:
        # This should be unreachable due to _require_account_user, but guard
        # against it just in case.
        raise HTTPException(status_code=403, detail=_ACCOUNT_REQUIRED_DETAIL)
    api_key_id = _ctx_api_key_id(ctx)

    is_admin = bool((ctx.get("info") or {}).get("is_admin"))
    payload_type = payload.type if is_admin else "Base"

    properties: dict = {
        "id": landmark_id,
        "type": payload_type,
        "label": label,
        "origin": "user",
        "added_by": display_name,
        "added_by_user_id": user_id,
        "added_at": now,
    }
    if payload.y is not None:
        # The existing schema overloads "z" for the Y/elevation value
        # (geometry.coordinates carries the world X/Z plane). Preserve it.
        properties["z"] = payload.y

    feature = {
        "type": "Feature",
        "properties": properties,
        "geometry": {"type": "Point", "coordinates": [int(payload.x), -int(payload.z)]},
    }

    async with _landmarks_lock:
        data = await asyncio.to_thread(_load_landmarks_file)
        data["features"].append(feature)
        await asyncio.to_thread(_save_landmarks_file, data)
        await asyncio.to_thread(
            db.insert_landmark_audit,
            landmark_id=landmark_id,
            action="add",
            actor_api_key_id=api_key_id,
            actor_display_name=display_name,
            after_payload=feature,
        )

    return {"landmark": feature}


@router.patch("/landmarks/{landmark_id}")
async def rename_landmark(
    landmark_id: str,
    payload: RenameLandmarkBody,
    ctx: dict = Depends(require_active_user),
) -> dict:
    """Rename a landmark.

    - If the caller owns the landmark (``added_by_user_id`` matches their api
      key), the rename is applied to the file immediately and the call
      returns ``{"applied": True, "landmark": <feature>}``.
    - Otherwise an entry is inserted into ``landmark_edit_requests`` and the
      response is ``{"applied": False, "edit_request": {...}}``. Any prior
      pending request from this caller for the same landmark is marked
      ``superseded`` so only the newest is actionable.
    """
    user = _require_account_user(ctx)
    new_label = _normalise_label(payload.label)
    api_key_id = _ctx_api_key_id(ctx)
    user_id = str(user["id"]) if user.get("id") is not None else None
    display_name = user.get("display_name") or "Anonymous"

    async with _landmarks_lock:
        data = await asyncio.to_thread(_load_landmarks_file)
        feature = _find_feature(data, landmark_id)
        if feature is None:
            raise HTTPException(status_code=404, detail="landmark not found")
        props = feature.setdefault("properties", {})
        current_label = str(props.get("label") or "")
        owner_id = props.get("added_by_user_id")
        is_owner = bool(owner_id) and bool(user_id) and str(owner_id) == user_id

        if current_label == new_label:
            # No-op rename — don't write an edit request or audit row.
            return {"applied": True, "landmark": feature, "noop": True}

        if is_owner:
            before = json.loads(json.dumps(feature))  # deep-copy snapshot
            props["label"] = new_label
            await asyncio.to_thread(_save_landmarks_file, data)
            await asyncio.to_thread(
                db.insert_landmark_audit,
                landmark_id=landmark_id,
                action="edit_own",
                actor_api_key_id=api_key_id,
                actor_display_name=display_name,
                before_payload=before,
                after_payload=feature,
            )
            return {"applied": True, "landmark": feature}

        # Non-owner / seeded → queue for admin review.
        request_id = str(uuid.uuid4())
        request_row = await asyncio.to_thread(
            db.insert_landmark_edit_request,
            request_id=request_id,
            landmark_id=landmark_id,
            submitted_by_api_key_id=api_key_id,
            submitted_by_display_name=display_name,
            current_label=current_label,
            proposed_label=new_label,
        )
        await asyncio.to_thread(
            db.insert_landmark_audit,
            landmark_id=landmark_id,
            action="edit_other_pending",
            actor_api_key_id=api_key_id,
            actor_display_name=display_name,
            before_payload={"label": current_label},
            after_payload={"label": new_label, "edit_request_id": request_id},
        )
        return {"applied": False, "edit_request": _serialise_edit_request(request_row)}


@router.get("/landmarks/my-edit-requests")
async def list_my_edit_requests(
    ctx: dict = Depends(require_active_user),
    limit: int = 50,
) -> dict:
    """Return the caller's recent rename requests (newest first)."""
    _require_account_user(ctx)
    api_key_id = _ctx_api_key_id(ctx)
    rows = await asyncio.to_thread(
        db.list_landmark_edit_requests,
        submitted_by_api_key_id=api_key_id,
        limit=max(1, min(int(limit), 200)),
    )
    return {"edit_requests": [_serialise_edit_request(r) for r in rows]}

"""Promotion-banner management + public read endpoints.

Public:
    GET  /api/promos/active          — the currently active, non-expired promo
                                        (requires a valid API key).
    GET  /api/promos/{id}/image      — the banner image (public; served so a
                                        plain ``<img src>`` can load it).

Management (admins OR a key holding the ``manage_promos`` permission):
    GET    /api/admin/promos         — list every promo
    POST   /api/admin/promos         — create a promo
    PATCH  /api/admin/promos/{id}    — edit fields / set active / set expiry
    POST   /api/admin/promos/{id}/image — upload the banner image (multipart)
    DELETE /api/admin/promos/{id}    — delete a promo
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import (
    APIRouter,
    Depends,
    File,
    Header,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from pydantic import BaseModel, Field

from ..auth import (
    require_permission,
    resolve_key_id,
    verify_api_key_info,
)
from ..core import accounts_db, database as db
from ..core import r2_storage


public_router = APIRouter(prefix="/promos", tags=["promos"])
admin_router = APIRouter(prefix="/admin/promos", tags=["admin-promos"])

_MANAGE_PERM = "manage_promos"

# Banner images are small; cap the upload so a fat-finger / hostile client
# can't balloon R2 storage.
_MAX_IMAGE_BYTES = 5 * 1024 * 1024
_ALLOWED_IMAGE_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
}

# Content is a free-form JSONB document (rich dialog fields). Cap its size so
# it can't be used to smuggle large blobs into the table.
_MAX_CONTENT_BYTES = 16 * 1024
_MAX_TITLE_LEN = 200


def _iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if hasattr(dt, "isoformat"):
        return dt.isoformat()
    return str(dt)


def _epoch_ms(dt: Optional[datetime]) -> int:
    if dt is None:
        return 0
    try:
        return int(dt.timestamp() * 1000)
    except Exception:
        return 0


def _promo_image_key(promo_id: str) -> str:
    return f"promos/{promo_id}/banner"


def _serialise_promo(row: dict) -> dict:
    """Shape a DB row for the API. ``image_url`` is a cache-busted path the
    frontend can drop straight into an ``<img>`` tag."""
    content = row.get("content")
    if not isinstance(content, dict):
        content = {}
    has_image = bool(row.get("image_key"))
    image_url = None
    if has_image:
        # Relative to the API base (frontend prepends ``API_BASE``). Cache-busted
        # on ``updated_at`` so a re-uploaded image refreshes immediately.
        image_url = f"/promos/{row['id']}/image?v={_epoch_ms(row.get('updated_at'))}"
    created_by = row.get("created_by_key_id")
    return {
        "id": row["id"],
        "title": row.get("title"),
        "content": content,
        "active": bool(row.get("active")),
        "expires_at": _iso(row.get("expires_at")),
        "has_image": has_image,
        "image_url": image_url,
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
        "created_by_suffix": (str(created_by)[-6:] if created_by else None),
    }


def _validate_content(content: Optional[dict]) -> dict:
    if content is None:
        return {}
    if not isinstance(content, dict):
        raise HTTPException(status_code=400, detail="content must be an object")
    import json as _json

    try:
        encoded = _json.dumps(content)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="content is not JSON-serialisable")
    if len(encoded.encode("utf-8")) > _MAX_CONTENT_BYTES:
        raise HTTPException(status_code=400, detail="content is too large")
    return content


def _normalise_expires_at(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class PromoCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=_MAX_TITLE_LEN)
    content: Optional[dict] = None
    expires_at: Optional[datetime] = None
    active: bool = False


class PromoPatch(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=_MAX_TITLE_LEN)
    content: Optional[dict] = None
    # ``None`` clears the expiry (never auto-expires); a missing field leaves
    # the current value untouched (handled via ``model_fields_set``).
    expires_at: Optional[datetime] = None
    active: Optional[bool] = None


# ---------------------------------------------------------------------------
# Public endpoints
# ---------------------------------------------------------------------------

@public_router.get("/active")
async def get_active_promo(
    request: Request,
    _info: dict = Depends(verify_api_key_info),
) -> dict:
    """Return the active, non-expired promotion (or ``{"promo": null}``)."""
    row = db.get_active_promo_event()
    return {"promo": _serialise_promo(row) if row else None}


@public_router.get("/{promo_id}/image")
async def get_promo_image(promo_id: str) -> Response:
    """Stream a promo's banner image from R2. Public (no auth) so a plain
    ``<img>`` tag can load it."""
    row = db.get_promo_event(promo_id)
    if not row or not row.get("image_key"):
        raise HTTPException(status_code=404, detail="Promo image not found")
    try:
        data = r2_storage.download_bytes(row["image_key"])
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Promo image not found")
    return Response(
        content=data,
        media_type=row.get("image_content_type") or "application/octet-stream",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ---------------------------------------------------------------------------
# Management endpoints
# ---------------------------------------------------------------------------

@admin_router.get("")
async def list_promos(_: str = Depends(require_permission(_MANAGE_PERM))) -> dict:
    rows = db.list_promo_events()
    return {"promos": [_serialise_promo(r) for r in rows]}


@admin_router.post("")
async def create_promo(
    body: PromoCreate,
    api_key: str = Depends(require_permission(_MANAGE_PERM)),
) -> dict:
    content = _validate_content(body.content)
    promo_id = uuid.uuid4().hex
    row = db.create_promo_event(
        promo_id,
        body.title.strip(),
        content=content,
        expires_at=_normalise_expires_at(body.expires_at),
        created_by_key_id=resolve_key_id(api_key),
    )
    if body.active:
        row = db.set_promo_event_active(promo_id, True) or row
    accounts_db.audit_log(
        api_key, "promo.create", target=promo_id, metadata={"title": body.title}
    )
    return {"promo": _serialise_promo(row)}


@admin_router.patch("/{promo_id}")
async def patch_promo(
    promo_id: str,
    body: PromoPatch,
    api_key: str = Depends(require_permission(_MANAGE_PERM)),
) -> dict:
    existing = db.get_promo_event(promo_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Promo not found")

    fields_set = body.model_fields_set
    updates: dict[str, Any] = {}
    if "title" in fields_set and body.title is not None:
        updates["title"] = body.title.strip()
    if "content" in fields_set:
        updates["content"] = _validate_content(body.content)
    if "expires_at" in fields_set:
        updates["expires_at"] = _normalise_expires_at(body.expires_at)

    row = existing
    if updates:
        row = db.update_promo_event(promo_id, **updates) or existing

    if "active" in fields_set and body.active is not None:
        row = db.set_promo_event_active(promo_id, body.active) or row

    accounts_db.audit_log(
        api_key,
        "promo.update",
        target=promo_id,
        metadata={"fields": sorted(fields_set)},
    )
    return {"promo": _serialise_promo(row)}


@admin_router.post("/{promo_id}/image")
async def upload_promo_image(
    promo_id: str,
    file: UploadFile = File(...),
    api_key: str = Depends(require_permission(_MANAGE_PERM)),
) -> dict:
    existing = db.get_promo_event(promo_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Promo not found")

    content_type = (file.content_type or "").split(";")[0].strip().lower()
    if content_type not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported image type. Allowed: {sorted(_ALLOWED_IMAGE_TYPES)}",
        )

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(data) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="Image too large (max 5 MB)")

    key = _promo_image_key(promo_id)
    r2_storage.upload_bytes(key, data, content_type=content_type)
    row = db.update_promo_event(
        promo_id, image_key=key, image_content_type=content_type
    )
    accounts_db.audit_log(api_key, "promo.image", target=promo_id)
    return {"promo": _serialise_promo(row or existing)}


@admin_router.delete("/{promo_id}")
async def delete_promo(
    promo_id: str,
    api_key: str = Depends(require_permission(_MANAGE_PERM)),
) -> dict:
    existing = db.get_promo_event(promo_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Promo not found")
    if existing.get("image_key"):
        try:
            r2_storage.delete_keys([existing["image_key"]])
        except Exception:
            pass
    deleted = db.delete_promo_event(promo_id)
    accounts_db.audit_log(api_key, "promo.delete", target=promo_id)
    return {"deleted": deleted}

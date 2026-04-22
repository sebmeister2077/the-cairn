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

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..auth import require_admin
from ..core import database as db

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
async def list_keys(_: str = Depends(require_admin)) -> List[dict]:
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    return [_serialise(r) for r in db.list_api_keys()]


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
async def list_invite_links(_: str = Depends(require_admin)) -> List[dict]:
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    return [_serialise_invite(r) for r in db.list_invite_links()]


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

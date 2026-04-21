"""Admin endpoints for dynamic API key management.

All routes require the ADMIN_API_KEY env-var key via the require_admin dependency.

GET    /api/admin/keys          — list all keys (key values masked)
POST   /api/admin/keys          — create a new key
DELETE /api/admin/keys/{key_id} — revoke a key
"""

import secrets
from typing import List

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

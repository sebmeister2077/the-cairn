"""Public invite-link claim endpoint.

POST /api/invite/{token}/claim
  — no auth required
  — validates the invite link is active, not expired, and not exhausted
  — creates a new API key with the permissions configured by the admin
  — returns the new API key (shown once to the user)
"""

import secrets

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core import database as db

router = APIRouter()


class ClaimResponse(BaseModel):
    key: str
    permissions: str
    invite_name: str


class DefaultInviteResponse(BaseModel):
    token: str
    name: str
    permissions: str


@router.get("/invite/default", response_model=DefaultInviteResponse)
async def get_default_invite():
    """Return the active default-public invite link, if one is configured.

    No auth required. Used by the landing page to offer a friendly key-claim
    flow to first-time visitors who arrived without an invite URL.
    Returns 404 if no link is currently flagged or the flagged link is
    revoked / expired / exhausted.
    """
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")
    link = db.get_default_public_invite_link()
    if not link:
        raise HTTPException(status_code=404, detail="No default invite link configured")
    return DefaultInviteResponse(
        token=link["token"],
        name=link["name"],
        permissions=link["permissions"],
    )


@router.post("/invite/{token}/claim", response_model=ClaimResponse)
async def claim_invite(token: str):
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")

    link = db.get_invite_link(token)
    if not link:
        raise HTTPException(status_code=404, detail="Invite link not found")
    if link["revoked"]:
        raise HTTPException(status_code=410, detail="This invite link has been revoked")

    # claim_invite_link atomically checks expiry / max_uses and increments use_count
    claimed = db.claim_invite_link(token)
    if not claimed:
        raise HTTPException(
            status_code=410,
            detail="This invite link has expired or reached its maximum number of uses",
        )

    new_key = secrets.token_urlsafe(32)
    name = f"Invite: {link['name']}"
    db.create_api_key(
        new_key,
        name,
        link["permissions"],
        False,
        source_invite_token=token,
    )

    return ClaimResponse(key=new_key, permissions=link["permissions"], invite_name=link["name"])

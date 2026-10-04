"""Public invite-link claim endpoint.

POST /api/invite/{token}/claim
  — no auth required
  — validates the invite link is active, not expired, and not exhausted
  — creates a new API key with the permissions configured by the admin
  — returns the new API key (shown once to the user)
"""

import secrets

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..auth import _get_client_ip, _hash_ip
from ..config import settings
from ..core import database as db

router = APIRouter()

# In production, an IP that already owns this many still-active invite accounts
# is handed back one of those existing keys instead of being allowed to mint
# yet another one (see ``claim_invite``). Keeps casual multi-account creation
# in check without hard-blocking the visitor.
_RECYCLE_AFTER_ACTIVE_ACCOUNTS = 4

# Substrings that mark a User-Agent as an automated client rather than a real
# browser. Invite claims are meant for humans arriving via a shared link, so we
# refuse to mint a key for anything that looks like a crawler/script. Browsers
# cannot override their User-Agent on fetch/XHR, so real visitors always pass.
_BOT_UA_MARKERS = (
    "bot",
    "crawl",
    "spider",
    "slurp",
    "curl",
    "wget",
    "python-requests",
    "python-httpx",
    "httpclient",
    "libwww",
    "scrapy",
    "headless",
    "phantomjs",
    "selenium",
    "playwright",
    "puppeteer",
    "go-http-client",
    "java/",
    "okhttp",
    "node-fetch",
    "aiohttp",
    "postman",
    "insomnia",
)


def _looks_like_bot(user_agent: str | None) -> bool:
    """Heuristic: does this User-Agent look like an automated client?"""
    if not user_agent or not user_agent.strip():
        return True
    ua = user_agent.lower()
    return any(marker in ua for marker in _BOT_UA_MARKERS)


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
async def claim_invite(token: str, request: Request):
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")

    # Don't mint keys for crawlers/scripts hitting the (often public) claim URL.
    if _looks_like_bot(request.headers.get("user-agent")):
        raise HTTPException(
            status_code=403,
            detail="Invite links can only be claimed from a web browser.",
        )

    link = db.get_invite_link(token)
    if not link:
        raise HTTPException(status_code=404, detail="Invite link not found")
    if link["revoked"]:
        raise HTTPException(status_code=410, detail="This invite link has been revoked")

    # Production-only guard: if this IP has already created several still-active
    # accounts via invite links, recycle one of those existing keys instead of
    # minting a new one. This throttles self-serve account farming from a single
    # IP while still letting the visitor back in. Skipped outside production so
    # the flow can be exercised locally with many throwaway accounts. Done
    # *before* claim_invite_link so a recycled hand-back never consumes a use.
    if settings.IS_PRODUCTION:
        ip_hash = _hash_ip(_get_client_ip(request))
        existing = db.list_active_invite_keys_for_ip(ip_hash)
        if len(existing) >= _RECYCLE_AFTER_ACTIVE_ACCOUNTS:
            recycled = existing[0]
            return ClaimResponse(
                key=recycled["key"],
                permissions=recycled["permissions"],
                invite_name=link["name"],
            )

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

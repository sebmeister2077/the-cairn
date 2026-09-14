"""No-trader trader-claim overlay endpoints.

The trader *claim* boxes ship as a static frontend asset
(``map-features.traderclaims.json``) — ~56k volumes. On a long-running server
(this one ran through several beta versions) some of those claims no longer
have an actual trader inside: the claim box persisted but its trader entity did
not. This router tracks the set of claims known to be **empty** (no trader) so
the map can flag them for everyone instead of implying a trader is there.

It is the mirror image of :mod:`trader_claim_types` — same shape, same locking,
same conflict policy — but records "this claim has no trader" instead of "this
claim is a trader of type X". Two write paths share the merge logic:

* ``manual``        — a logged-in user / admin marking. ``POST
  /trader-claim-empty``, requires an account, gated by
  ``trader_claim_empty_manual`` and rate-limited by
  ``trader_claim_empty_manual_daily_cap`` (default 30/day).
* ``authoritative`` — the VSProxy, derived from an actual scan of the claim
  volume (no trader hut blocks / no trader entity found). ``POST
  /trader-claim-empty/authoritative``, requires an admin key or a key with the
  ``map_features_publish`` permission, gated by
  ``trader_claim_empty_authoritative``.

Each item carries an ``empty`` boolean so the same endpoint both **marks** a
claim empty (``empty=true``) and **clears** it when a trader is later found
(``empty=false``). Conflict policy: **authoritative always wins**. A manual
mark cannot override an authoritative value; a manual clear cannot remove an
authoritative mark (admins may override either).

Claim id is the quantised absolute claim centre ``"x:y:z"`` (integers) — the
same key used by the static asset and the type overlay, so the two overlays
merge by lookup on the frontend. The live merged view is the R2 object
``trader_claim_empty.json``; this router writes it under the shared geojson
lock and records every change in ``trader_claim_empty_audit``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from ..auth import (
    is_admin_key,
    require_active_user,
    verify_api_key,
    verify_permission,
)
from ..core import database as db
from ..core import feature_flags
from ..core import r2_storage


logger = logging.getLogger("uvicorn.error")
router = APIRouter(tags=["trader-claim-empty"])

# Single-process serialisation of read-modify-upload of trader_claim_empty.json.
_empty_lock = asyncio.Lock()
_LOCK_WAIT_SECONDS = 15.0
_LOCK_POLL_SECONDS = 0.1
_LOCK_RESOURCE = "trader_claim_empty"


@contextlib.asynccontextmanager
async def empty_claims_write_lock(action: str):
    """In-process + DB-backed mutex around the overlay read-modify-upload.
    Mirrors ``trader_claim_types.claim_types_write_lock``."""
    async with _empty_lock:
        token: Optional[str] = None
        deadline = time.monotonic() + _LOCK_WAIT_SECONDS
        while True:
            try:
                token = await asyncio.to_thread(
                    db.try_acquire_geojson_lock, _LOCK_RESOURCE, action
                )
            except Exception:
                logger.exception("trader-claim-empty: DB lock acquisition raised")
                raise HTTPException(
                    status_code=503,
                    detail="empty-claim lock backend unavailable; retry",
                )
            if token:
                break
            if time.monotonic() >= deadline:
                raise HTTPException(
                    status_code=503,
                    detail="trader_claim_empty.json is locked by another writer; retry",
                )
            await asyncio.sleep(_LOCK_POLL_SECONDS)
        try:
            yield token
        finally:
            try:
                await asyncio.to_thread(
                    db.release_geojson_lock, _LOCK_RESOURCE, token
                )
            except Exception:
                logger.exception("trader-claim-empty: DB lock release raised")


# Claim id is the quantised absolute claim centre "x:y:z" (integers, signed).
_CLAIM_ID_RE = re.compile(r"^-?\d{1,8}:-?\d{1,8}:-?\d{1,8}$")

_COORD_LIMIT = 4_000_000
_MAX_BATCH = 500

_VIEWER_FLAG = "trader_claim_empty_viewer"
_MANUAL_FLAG = "trader_claim_empty_manual"
_AUTHORITATIVE_FLAG = "trader_claim_empty_authoritative"
_MANUAL_DAILY_CAP_FLAG = "trader_claim_empty_manual_daily_cap"
_MANUAL_MAX_PER_DAY_DEFAULT = 30
_DAY_SECONDS = 86400
# The authoritative publish rides on the general map-features export permission.
_PUBLISH_PERMISSION = "map_features_publish"
_LEGACY_PUBLISH_PERMISSION = "trader_claims_publish"


# ---------------------------------------------------------------------------
# Overlay load / save
# ---------------------------------------------------------------------------

def _empty_overlay() -> dict:
    return {"version": 1, "updatedAt": None, "claims": {}}


def _load_overlay() -> dict:
    key = r2_storage.trader_claim_empty_key()
    try:
        raw = r2_storage.download_bytes(key)
    except FileNotFoundError:
        return _empty_overlay()
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        logger.exception("trader-claim-empty: failed to parse R2 file")
        raise HTTPException(status_code=500, detail=f"Corrupt overlay file: {exc}")
    if not isinstance(data, dict) or not isinstance(data.get("claims"), dict):
        raise HTTPException(
            status_code=500, detail="Corrupt overlay file (no claims map)"
        )
    return data


def _save_overlay(data: dict) -> None:
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    key = r2_storage.trader_claim_empty_key()
    r2_storage.upload_bytes(key, body, content_type="application/json")
    r2_storage.invalidate_presigned_download_url(key)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class Vec3(BaseModel):
    x: float
    y: float
    z: float


class EmptyClaimItem(BaseModel):
    claim_id: str
    # True marks the claim empty (no trader); False clears it (trader found).
    empty: bool = True
    center: Optional[Vec3] = None


class EmptyClaimBody(BaseModel):
    items: List[EmptyClaimItem] = Field(..., min_length=1)
    client_batch_id: Optional[str] = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _validate_items(items: List[EmptyClaimItem]) -> None:
    if len(items) > _MAX_BATCH:
        raise HTTPException(
            status_code=400, detail=f"too many items in one batch (max {_MAX_BATCH})"
        )
    for idx, it in enumerate(items):
        if not _CLAIM_ID_RE.match(it.claim_id):
            raise HTTPException(
                status_code=400, detail=f"item {idx}: invalid claim_id"
            )
        if it.center is not None:
            for v, name in ((it.center.x, "x"), (it.center.y, "y"), (it.center.z, "z")):
                if abs(v) > _COORD_LIMIT:
                    raise HTTPException(
                        status_code=400, detail=f"item {idx}: center.{name} out of range"
                    )


def _merge(
    data: dict,
    items: List[EmptyClaimItem],
    *,
    source: str,
    actor_display_name: Optional[str],
    allow_override_authoritative: bool,
) -> list:
    """Apply items under the conflict policy. Returns a list of
    ``(claim_id, action, before, after)`` for the entries that actually
    changed, where ``action`` is ``"add"`` (marked empty) or ``"remove"``
    (cleared)."""
    claims = data.setdefault("claims", {})
    now_iso = _now_iso()
    changed: list = []
    for it in items:
        existing = claims.get(it.claim_id)
        existing_auth = (
            isinstance(existing, dict) and existing.get("source") == "authoritative"
        )
        # Manual writers cannot touch an authoritative entry (admins may).
        if (
            source != "authoritative"
            and existing_auth
            and not allow_override_authoritative
        ):
            continue

        if it.empty:
            if existing is not None and existing.get("source") == source:
                continue  # no-op, avoid audit noise
            after = {
                "source": source,
                "center": it.center.model_dump() if it.center is not None
                else (existing or {}).get("center"),
                "updated_by": actor_display_name,
                "updated_at": now_iso,
            }
            claims[it.claim_id] = after
            changed.append((it.claim_id, "add", existing, after))
        else:
            if existing is None:
                continue  # already not empty, nothing to clear
            del claims[it.claim_id]
            changed.append((it.claim_id, "remove", existing, None))
    if changed:
        data["updatedAt"] = now_iso
    return changed


async def _write_and_audit(
    items: List[EmptyClaimItem],
    *,
    source: str,
    action_lock: str,
    actor_display_name: Optional[str],
    api_key_id: Optional[str],
    allow_override_authoritative: bool = False,
) -> dict:
    async with empty_claims_write_lock(action_lock):
        data = await asyncio.to_thread(_load_overlay)
        changed = _merge(
            data, items,
            source=source,
            actor_display_name=actor_display_name,
            allow_override_authoritative=allow_override_authoritative,
        )
        if changed:
            await asyncio.to_thread(_save_overlay, data)

    for claim_id, action, before, after in changed:
        center = None
        if isinstance(after, dict):
            center = after.get("center")
        elif isinstance(before, dict):
            center = before.get("center")
        await asyncio.to_thread(
            db.insert_trader_claim_empty_audit,
            claim_id=claim_id,
            action=action,
            actor_api_key_id=api_key_id,
            actor_display_name=actor_display_name,
            source=source,
            center=center,
            before_payload=before,
            after_payload=after,
        )
    return {"accepted": len(changed), "submitted": len(items)}


# ---------------------------------------------------------------------------
# Write endpoints
# ---------------------------------------------------------------------------

@router.post("/trader-claim-empty")
async def contribute_empty_claims(
    payload: EmptyClaimBody,
    ctx: dict = Depends(require_active_user),
) -> dict:
    """Manual (logged-in) empty-claim marking. Rate-limited; cannot override an
    authoritative value unless the caller is an admin."""
    if not feature_flags.is_feature_enabled_default(_MANUAL_FLAG, False):
        raise HTTPException(
            status_code=503,
            detail={
                "code": "feature_disabled",
                "message": "Manual no-trader marking is currently disabled.",
            },
        )
    user = ctx.get("user")
    if user is None:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "account_required",
                "message": "Create an account to mark empty trader claims.",
            },
        )
    info = ctx.get("info") or {}
    api_key_id = str(info["id"]) if info.get("id") is not None else None
    is_admin = bool(info.get("is_admin"))
    display_name = user.get("display_name") or "Anonymous"

    _validate_items(payload.items)

    if not is_admin and api_key_id:
        cap = feature_flags.get_int(_MANUAL_DAILY_CAP_FLAG, _MANUAL_MAX_PER_DAY_DEFAULT)
        recent = await asyncio.to_thread(
            db.count_trader_claim_empty_submissions_in_window,
            actor_api_key_id=api_key_id,
            source="manual",
            window_seconds=_DAY_SECONDS,
        )
        if recent >= cap:
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "rate_limited",
                    "message": f"Daily no-trader marking limit reached ({cap} per 24h).",
                    "retry_after_seconds": _DAY_SECONDS,
                },
            )

    return await _write_and_audit(
        payload.items,
        source="manual",
        action_lock="contribute-manual",
        actor_display_name=display_name,
        api_key_id=api_key_id,
        allow_override_authoritative=is_admin,
    )


@router.post("/trader-claim-empty/authoritative")
async def publish_empty_claims(
    payload: EmptyClaimBody,
    request: Request,
    x_api_key: str = Depends(verify_api_key),
    x_actor_name: Optional[str] = Header(None, alias="X-Actor-Name"),
) -> dict:
    """Authoritative (proxy) empty-claim marking, derived from an actual scan of
    the claim volume. Requires an admin key or the ``map_features_publish``
    permission. Always wins over manual values."""
    if not feature_flags.is_feature_enabled_default(_AUTHORITATIVE_FLAG, False):
        raise HTTPException(
            status_code=503,
            detail={
                "code": "feature_disabled",
                "message": "Authoritative no-trader publishing is currently disabled.",
            },
        )
    if not (
        is_admin_key(x_api_key)
        or verify_permission(x_api_key, _PUBLISH_PERMISSION)
        or verify_permission(x_api_key, _LEGACY_PUBLISH_PERMISSION)
    ):
        raise HTTPException(
            status_code=403,
            detail="This API key cannot publish authoritative empty claims.",
        )

    _validate_items(payload.items)

    actor_name = (x_actor_name or "proxy").strip()[:64] or "proxy"
    return await _write_and_audit(
        payload.items,
        source="authoritative",
        action_lock="publish-authoritative",
        actor_display_name=actor_name,
        api_key_id=None,
    )


# ---------------------------------------------------------------------------
# Read endpoint
# ---------------------------------------------------------------------------

@router.get("/trader-claim-empty/url")
async def get_empty_claims_url(
    request: Request, api_key: str = Depends(verify_api_key)
) -> dict:
    """Presigned download URL for the merged overlay. Returns
    ``{url: None, disabled: True}`` when the viewer flag is off and
    ``{url: None, empty: True}`` when no markings exist yet."""
    if not feature_flags.is_feature_enabled_default(_VIEWER_FLAG, False):
        return {"url": None, "disabled": True}
    key = r2_storage.trader_claim_empty_key()
    if not r2_storage.object_exists(key):
        return {"url": None, "empty": True}
    url = r2_storage.generate_presigned_download_url(
        key,
        expires_seconds=7 * 24 * 60 * 60,
        content_type="application/json",
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
        "expires_in_seconds": int(7 * 24 * 60 * 60 * 0.75),
    }

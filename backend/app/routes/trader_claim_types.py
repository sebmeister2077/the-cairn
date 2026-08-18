"""Trader-claim type overlay endpoints.

The trader *claim* boxes ship as a static frontend asset
(``map-features.traderclaims.json``) — ~56k volumes with no trader type. This
router lets clients assign a ``trader_type`` to a claim so it renders coloured
(instead of a neutral "unclassified" dot) for everyone.

Two write paths share the merge logic, distinguished by ``source`` and by
which auth dependency guards them:

* ``manual``        — a logged-in user's guess. ``POST /trader-claim-types``,
  requires an account, gated by ``trader_claims_manual`` and rate-limited by
  ``trader_claims_manual_daily_cap`` (default 30/day).
* ``authoritative`` — the VsClayProxy, derived from the in-game trader entity
  code (``game:trader-{gender}-{type}-{climate}``). ``POST
  /trader-claim-types/authoritative``, requires an admin key or a key with the
  ``trader_claims_publish`` permission, gated by ``trader_claims_authoritative``.

Conflict policy: **authoritative always wins**. A manual guess only fills a
claim that has no authoritative value yet; it may overwrite another manual
value but never an authoritative one.

Claim id is the quantised absolute claim centre ``"x:y:z"`` (integers). The
frontend computes the same id from the static asset's ``center`` so the
overlay merges by lookup. No Z-negation: both sides use the same absolute
centre.

The live merged view is the R2 object ``trader_claim_types.json``; this router
writes it under the shared geojson lock and records every change in
``trader_claim_types_audit``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import time
import uuid
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
router = APIRouter(tags=["trader-claim-types"])

# Single-process serialisation of read-modify-upload of trader_claim_types.json.
_claims_lock = asyncio.Lock()
_LOCK_WAIT_SECONDS = 15.0
_LOCK_POLL_SECONDS = 0.1
_LOCK_RESOURCE = "trader_claim_types"


@contextlib.asynccontextmanager
async def claim_types_write_lock(action: str):
    """In-process + DB-backed mutex around the overlay read-modify-upload.
    Mirrors ``contribute_traders.traders_write_lock``."""
    async with _claims_lock:
        token: Optional[str] = None
        deadline = time.monotonic() + _LOCK_WAIT_SECONDS
        while True:
            try:
                token = await asyncio.to_thread(
                    db.try_acquire_geojson_lock, _LOCK_RESOURCE, action
                )
            except Exception:
                logger.exception("trader-claim-types: DB lock acquisition raised")
                raise HTTPException(
                    status_code=503,
                    detail="claim-type lock backend unavailable; retry",
                )
            if token:
                break
            if time.monotonic() >= deadline:
                raise HTTPException(
                    status_code=503,
                    detail="trader_claim_types.json is locked by another writer; retry",
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
                logger.exception("trader-claim-types: DB lock release raised")


_TRADER_TYPES = frozenset((
    "agriculture",
    "artisan",
    "building_materials",
    "clothing",
    "commodities",
    "furniture",
    "luxuries",
    "survival_goods",
    "treasure_hunter",
))

# Claim id is the quantised absolute claim centre "x:y:z" (integers, signed).
_CLAIM_ID_RE = re.compile(r"^-?\d{1,8}:-?\d{1,8}:-?\d{1,8}$")

_COORD_LIMIT = 4_000_000
_MAX_BATCH = 500

_VIEWER_FLAG = "trader_claims_viewer"
_MANUAL_FLAG = "trader_claims_manual"
_AUTHORITATIVE_FLAG = "trader_claims_authoritative"
_MANUAL_DAILY_CAP_FLAG = "trader_claims_manual_daily_cap"
_MANUAL_MAX_PER_DAY_DEFAULT = 30
_DAY_SECONDS = 86400
# The authoritative publish is now part of the general map-features export, so the general
# ``map_features_publish`` permission grants it. The legacy ``trader_claims_publish`` is still
# accepted for keys granted before the unification.
_PUBLISH_PERMISSION = "map_features_publish"
_LEGACY_PUBLISH_PERMISSION = "trader_claims_publish"


# ---------------------------------------------------------------------------
# Overlay load / save
# ---------------------------------------------------------------------------

def _empty_overlay() -> dict:
    return {"version": 1, "updatedAt": None, "claims": {}}


def _load_overlay() -> dict:
    key = r2_storage.trader_claim_types_key()
    try:
        raw = r2_storage.download_bytes(key)
    except FileNotFoundError:
        return _empty_overlay()
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        logger.exception("trader-claim-types: failed to parse R2 file")
        raise HTTPException(status_code=500, detail=f"Corrupt overlay file: {exc}")
    if not isinstance(data, dict) or not isinstance(data.get("claims"), dict):
        raise HTTPException(
            status_code=500, detail="Corrupt overlay file (no claims map)"
        )
    return data


def _save_overlay(data: dict) -> None:
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    key = r2_storage.trader_claim_types_key()
    r2_storage.upload_bytes(key, body, content_type="application/json")
    r2_storage.invalidate_presigned_download_url(key)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class Vec3(BaseModel):
    x: float
    y: float
    z: float


class ClaimTypeItem(BaseModel):
    claim_id: str
    trader_type: str
    center: Optional[Vec3] = None


class ClaimTypeBody(BaseModel):
    items: List[ClaimTypeItem] = Field(..., min_length=1)
    client_batch_id: Optional[str] = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _validate_items(items: List[ClaimTypeItem]) -> None:
    if len(items) > _MAX_BATCH:
        raise HTTPException(
            status_code=400, detail=f"too many items in one batch (max {_MAX_BATCH})"
        )
    for idx, it in enumerate(items):
        if not _CLAIM_ID_RE.match(it.claim_id):
            raise HTTPException(
                status_code=400, detail=f"item {idx}: invalid claim_id"
            )
        if it.trader_type not in _TRADER_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"item {idx}: unknown trader_type '{it.trader_type}'",
            )
        if it.center is not None:
            for v, name in ((it.center.x, "x"), (it.center.y, "y"), (it.center.z, "z")):
                if abs(v) > _COORD_LIMIT:
                    raise HTTPException(
                        status_code=400, detail=f"item {idx}: center.{name} out of range"
                    )


def _merge(
    data: dict,
    items: List[ClaimTypeItem],
    *,
    source: str,
    actor_display_name: Optional[str],
    api_key_id: Optional[str],
) -> list:
    """Apply items under the conflict policy. Returns a list of
    ``(claim_id, before, after)`` for the entries that actually changed."""
    claims = data.setdefault("claims", {})
    now_iso = _now_iso()
    changed: list = []
    for it in items:
        existing = claims.get(it.claim_id)
        if source == "manual" and existing is not None and existing.get("source") == "authoritative":
            continue  # authoritative wins — manual cannot override it
        if (
            existing is not None
            and existing.get("trader_type") == it.trader_type
            and existing.get("source") == source
        ):
            continue  # no-op, avoid audit noise
        after = {
            "trader_type": it.trader_type,
            "source": source,
            "center": it.center.model_dump() if it.center is not None
            else (existing or {}).get("center"),
            "updated_by": actor_display_name,
            "updated_at": now_iso,
        }
        claims[it.claim_id] = after
        changed.append((it.claim_id, existing, after))
    if changed:
        data["updatedAt"] = now_iso
    return changed


async def _write_and_audit(
    items: List[ClaimTypeItem],
    *,
    source: str,
    action_lock: str,
    actor_display_name: Optional[str],
    api_key_id: Optional[str],
) -> dict:
    async with claim_types_write_lock(action_lock):
        data = await asyncio.to_thread(_load_overlay)
        changed = _merge(
            data, items,
            source=source,
            actor_display_name=actor_display_name,
            api_key_id=api_key_id,
        )
        if changed:
            await asyncio.to_thread(_save_overlay, data)

    for claim_id, before, after in changed:
        await asyncio.to_thread(
            db.insert_trader_claim_type_audit,
            claim_id=claim_id,
            action="add",
            actor_api_key_id=api_key_id,
            actor_display_name=actor_display_name,
            source=source,
            trader_type=after["trader_type"],
            center=after.get("center"),
            before_payload=before,
            after_payload=after,
        )
    return {"accepted": len(changed), "submitted": len(items)}


# ---------------------------------------------------------------------------
# Write endpoints
# ---------------------------------------------------------------------------

@router.post("/trader-claim-types")
async def contribute_claim_types(
    payload: ClaimTypeBody,
    ctx: dict = Depends(require_active_user),
) -> dict:
    """Manual (logged-in) claim-type assignment. Rate-limited; cannot
    override an authoritative value."""
    if not feature_flags.is_feature_enabled_default(_MANUAL_FLAG, False):
        raise HTTPException(
            status_code=503,
            detail={
                "code": "feature_disabled",
                "message": "Manual claim-type marking is currently disabled.",
            },
        )
    user = ctx.get("user")
    if user is None:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "account_required",
                "message": "Create an account to mark trader claim types.",
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
            db.count_trader_claim_type_submissions_in_window,
            actor_api_key_id=api_key_id,
            source="manual",
            window_seconds=_DAY_SECONDS,
        )
        if recent >= cap:
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "rate_limited",
                    "message": f"Daily claim-type marking limit reached ({cap} per 24h).",
                    "retry_after_seconds": _DAY_SECONDS,
                },
            )

    return await _write_and_audit(
        payload.items,
        source="manual",
        action_lock="contribute-manual",
        actor_display_name=display_name,
        api_key_id=api_key_id,
    )


@router.post("/trader-claim-types/authoritative")
async def publish_claim_types(
    payload: ClaimTypeBody,
    request: Request,
    x_api_key: str = Depends(verify_api_key),
    x_actor_name: Optional[str] = Header(None, alias="X-Actor-Name"),
) -> dict:
    """Authoritative (proxy) claim-type assignment, derived from the in-game
    trader entity code. Requires an admin key or the ``trader_claims_publish``
    permission. Always wins over manual values."""
    if not feature_flags.is_feature_enabled_default(_AUTHORITATIVE_FLAG, False):
        raise HTTPException(
            status_code=503,
            detail={
                "code": "feature_disabled",
                "message": "Authoritative claim-type publishing is currently disabled.",
            },
        )
    if not (
        is_admin_key(x_api_key)
        or verify_permission(x_api_key, _PUBLISH_PERMISSION)
        or verify_permission(x_api_key, _LEGACY_PUBLISH_PERMISSION)
    ):
        raise HTTPException(
            status_code=403,
            detail="This API key cannot publish authoritative claim types.",
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

@router.get("/trader-claim-types/url")
async def get_claim_types_url(
    request: Request, api_key: str = Depends(verify_api_key)
) -> dict:
    """Presigned download URL for the merged overlay. Returns
    ``{url: None, disabled: True}`` when the viewer flag is off and
    ``{url: None, empty: True}`` when no assignments exist yet."""
    if not feature_flags.is_feature_enabled_default(_VIEWER_FLAG, False):
        return {"url": None, "disabled": True}
    key = r2_storage.trader_claim_types_key()
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

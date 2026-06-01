"""Elk-walkable edges public + user endpoints.

Surfaces:

- ``GET  /api/elk-walkable/url`` — presigned download URL of the live
  ``elk_walkable.json``. Public, mirrors ``GET /api/translocators/url``.
- ``POST /api/elk-walkable/submit`` — apply a batch of attest /
  unattest changes from a logged-in user. Gated by the
  ``elk_walkable_contributions`` feature flag (default OFF) and a daily
  per-key cap (``elk_walkable_daily_cap``, default 10).

The frontend writes nothing until the user clicks Submit, so each call
to ``/submit`` is a deliberate user action and counts against the cap.
"""

from __future__ import annotations

import asyncio
import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_active_user
from ..core import database as db
from ..core import elk_walkable_store
from ..core import feature_flags
from ..core import r2_storage
from ..rate_limiter import check_scoped_rate_limit


logger = logging.getLogger("uvicorn.error")
router = APIRouter(tags=["elk-walkable"])

_FLAG_KEY = "elk_walkable_contributions"
_DAILY_CAP_FLAG = "elk_walkable_daily_cap"
_DAILY_CAP_DEFAULT = 10
_RATE_SCOPE = "elk-walkable-submit"
_RATE_WINDOW = 86400  # 24 hours

# Defensive batch cap. The UI lets the user accumulate draft entries
# locally and submit them all at once; this guard rejects obviously
# malformed payloads without burning a write.
_MAX_BATCH = 200

# 7 days — the maximum a presigned GET URL can live (S3v4 cap). The
# frontend will refresh against ``/url`` long before this.
_PRESIGN_TTL_SECONDS = 7 * 24 * 60 * 60

_FLAG_OFF_DETAIL = {
    "code": "feature_disabled",
    "message": "Elk-walkable attestations are currently disabled.",
}
_ACCOUNT_REQUIRED_DETAIL = {
    "code": "account_required",
    "message": "Create an account to mark walk segments as elk-friendly.",
}
_NOTE_MAX_LEN = 280


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class EdgeEndpointRef(BaseModel):
    tl_id: str = Field(..., min_length=1, max_length=128)
    ep: int = Field(..., ge=0, le=1)


class EdgeRef(BaseModel):
    a: EdgeEndpointRef
    b: EdgeEndpointRef


class ElkWalkableSubmitBody(BaseModel):
    attest: List[EdgeRef] = Field(default_factory=list)
    unattest: List[EdgeRef] = Field(default_factory=list)
    note: Optional[str] = Field(default=None, max_length=_NOTE_MAX_LEN)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _require_account_user(ctx: dict) -> dict:
    user = ctx.get("user")
    if user is None:
        raise HTTPException(status_code=403, detail=_ACCOUNT_REQUIRED_DETAIL)
    return user


def _ctx_api_key_id(ctx: dict) -> Optional[str]:
    info = ctx.get("info") or {}
    raw = info.get("id")
    return str(raw) if raw is not None else None


def _load_translocator_ids() -> set:
    """Collect every TL ``properties.id`` from the live translocators
    geojson. Used to validate submissions referencing server-assigned
    ids. Synthetic ``xz:x1,z1,x2,z2`` fallback ids (used by features
    without an assigned id, e.g. WebCartographer-sourced maps) are
    accepted by the store directly — see ``_validate_tl_ids``."""
    try:
        raw = r2_storage.download_bytes(r2_storage.translocators_live_key())
    except FileNotFoundError:
        raise HTTPException(
            status_code=503,
            detail="translocators.geojson missing from R2",
        )
    import json
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"corrupt translocators file: {exc}")
    out: set = set()
    for feat in data.get("features") or []:
        if not isinstance(feat, dict):
            continue
        tl_id = (feat.get("properties") or {}).get("id")
        if isinstance(tl_id, str) and tl_id:
            out.add(tl_id)
    return out


# ---------------------------------------------------------------------------
# Public read
# ---------------------------------------------------------------------------

@router.get("/elk-walkable/url")
async def get_elk_walkable_url() -> dict:
    """Return a presigned URL for ``elk_walkable.json``. If the file does
    not yet exist (no attestations have ever been recorded), returns an
    empty inline body so the frontend can hydrate without a 404."""
    key = r2_storage.elk_walkable_live_key()
    if not r2_storage.object_exists(key):
        return {"url": "", "etag": "", "expires_in_seconds": 0,
                "empty": True}
    url = r2_storage.generate_presigned_download_url(
        key,
        expires_seconds=_PRESIGN_TTL_SECONDS,
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
        "expires_in_seconds": int(_PRESIGN_TTL_SECONDS * 0.75),
    }


# ---------------------------------------------------------------------------
# Submit
# ---------------------------------------------------------------------------

@router.post("/elk-walkable/submit")
async def submit_elk_walkable(
    payload: ElkWalkableSubmitBody,
    ctx: dict = Depends(require_active_user),
) -> dict:
    if not feature_flags.is_feature_enabled_default(_FLAG_KEY, False):
        raise HTTPException(status_code=503, detail=_FLAG_OFF_DETAIL)

    user = _require_account_user(ctx)

    if not payload.attest and not payload.unattest:
        raise HTTPException(status_code=400, detail="empty submission")
    total = len(payload.attest) + len(payload.unattest)
    if total > _MAX_BATCH:
        raise HTTPException(
            status_code=400,
            detail=f"too many changes in one batch (max {_MAX_BATCH})",
        )

    is_admin = bool((ctx.get("info") or {}).get("is_admin"))
    if not is_admin:
        check_scoped_rate_limit(
            ctx["key"],
            _RATE_SCOPE,
            feature_flags.get_int(_DAILY_CAP_FLAG, _DAILY_CAP_DEFAULT),
            _RATE_WINDOW,
        )

    api_key_id = _ctx_api_key_id(ctx)
    user_id = str(user["id"]) if user.get("id") is not None else None
    display_name = user.get("display_name") or "Anonymous"

    valid_ids = await asyncio.to_thread(_load_translocator_ids)
    attest_dicts = [r.model_dump() for r in payload.attest]
    unattest_dicts = [r.model_dump() for r in payload.unattest]

    async with elk_walkable_store.elk_walkable_write_lock("submit"):
        result = await asyncio.to_thread(
            elk_walkable_store.apply_changes,
            actor_api_key_id=api_key_id,
            actor_user_id=user_id,
            actor_display_name=display_name,
            attest=attest_dicts,
            unattest=unattest_dicts,
            valid_tl_ids=valid_ids,
            note=payload.note,
        )

    return {
        "change_id": result["change_id"],
        "applied_count": len(result["applied"]),
        "audit_ids": result["audit_ids"],
    }


# ---------------------------------------------------------------------------
# Caller-facing self-history
# ---------------------------------------------------------------------------

@router.get("/account/elk-walkable")
async def my_elk_walkable_contributions(
    ctx: dict = Depends(require_active_user),
) -> dict:
    """List the caller's own elk-walkable attestation history."""
    _require_account_user(ctx)
    api_key_id = _ctx_api_key_id(ctx)
    if not api_key_id:
        return {"contributions": []}
    rows = await asyncio.to_thread(
        db.list_elk_walkable_audit,
        actor_api_key_id=api_key_id,
        limit=500,
    )
    out = []
    for r in rows:
        created = r.get("created_at")
        out.append({
            "id": r.get("id"),
            "change_id": r.get("change_id"),
            "action": r.get("action"),
            "edge_key": r.get("edge_key"),
            "created_at": (
                created.isoformat() if hasattr(created, "isoformat") else created
            ),
        })
    return {"contributions": out}

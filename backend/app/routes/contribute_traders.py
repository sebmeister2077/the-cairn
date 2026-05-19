"""User-contributed Traders endpoint.

POST /api/contribute-traders — append user-submitted Traders to the live
``traders.geojson`` in R2 and write one audit row per accepted trader.

Two submission paths share this endpoint, distinguished by ``source``:

* ``source="chatlog"`` — chat-log import (the user dumps a chat log and
  the frontend extracts ``/waypoint`` lines that look like traders).
  Rate-limited to **1 batch/day** for non-admins.
* ``source="manual"``  — manual entry (user types coords + name + picks
  a type from a dropdown). Rate-limited to **15 batches/day** for
  non-admins.

Each ``source`` is gated by an **independent** feature flag
(``traders_chatlog_contributions`` / ``traders_manual_contributions``)
so an operator can ship one path before the other. The viewer flag
(``traders_viewer``) is checked client-side for the public overlay
toggle; admins and contributors with submissions can always see what
they uploaded via the contributor list view.

Mirrors [contribute_tls.py] structurally:
- account-required (no anonymous submissions),
- single-process asyncio lock around read-modify-upload of the geojson,
- Z is **negated on the way in** (geojson stores +Z = south, frontend
  speaks +Z = north — see translocators / landmarks for precedent),
- audit rows written outside the lock.

Dedupe: trader within ``_DUPLICATE_RADIUS`` blocks (60) of an existing
trader of any type is **still accepted** but the audit row carries
``duplicate_flagged=TRUE`` so admins can review.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..auth import require_active_user, verify_api_key
from ..core import database as db
from ..core import feature_flags
from ..core import r2_storage


logger = logging.getLogger("uvicorn.error")
router = APIRouter(tags=["contribute-traders"])

# Single-process serialisation of read-modify-upload of traders.geojson.
# Shared with admin_traders delete / restore paths via attribute access.
_traders_lock = asyncio.Lock()

# Coordinate sanity limits. Same as landmarks / translocators.
_COORD_LIMIT = 4_000_000

# Per-batch cap. Trader populations on a long-running server stay well
# under this; anything larger is suspicious.
_MAX_BATCH = 200

# Server-side dedupe radius (blocks). A trader within this radius of any
# existing trader (any type) is still inserted but flagged in the audit
# row for admin review. The Tops Map UI does not surface this to the
# submitter — they get an accepted count, not a duplicate count.
_DUPLICATE_RADIUS = 60

# Label is short user-controlled text. Reuse landmark / translocator caps.
_LABEL_MAX_LEN = 200

_VIEWER_FLAG = "traders_viewer"
_CHATLOG_FLAG = "traders_chatlog_contributions"
_MANUAL_FLAG = "traders_manual_contributions"

# Per-user daily caps on submissions. Counted directly off ``traders_audit``
# (action='add', source=X) rather than the generic rate_limiter table so the
# limit survives container restarts and stays exact.
_CHATLOG_MAX_PER_DAY = 1
_MANUAL_MAX_PER_DAY = 15
_DAY_SECONDS = 86400

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

_ACCOUNT_REQUIRED_DETAIL = {
    "code": "account_required",
    "message": "Create an account to contribute traders.",
}


def _flag_off_detail(label: str) -> dict:
    return {
        "code": "feature_disabled",
        "message": f"Trader {label} contributions are currently disabled.",
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalise_label(raw: Optional[str]) -> str:
    if raw is None:
        return ""
    if not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="label must be a string")
    s = raw.replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(s) > _LABEL_MAX_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"label is too long (max {_LABEL_MAX_LEN} chars)",
        )
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", s):
        raise HTTPException(
            status_code=400, detail="label contains invalid control characters"
        )
    return s


def _require_account_user(ctx: dict) -> dict:
    user = ctx.get("user")
    if user is None:
        raise HTTPException(status_code=403, detail=_ACCOUNT_REQUIRED_DETAIL)
    return user


def _ctx_api_key_id(ctx: dict) -> Optional[str]:
    info = ctx.get("info") or {}
    raw = info.get("id")
    return str(raw) if raw is not None else None


# ---------------------------------------------------------------------------
# Geojson load / save
# ---------------------------------------------------------------------------

def _empty_traders_doc() -> dict:
    return {"type": "FeatureCollection", "features": []}


def _load_traders_file() -> dict:
    """Download + parse the live traders.geojson from R2. Unlike landmarks /
    translocators we **bootstrap** an empty file if it's missing — there's
    no static seed; the file accumulates from contributions only."""
    key = r2_storage.traders_live_key()
    try:
        raw = r2_storage.download_bytes(key)
    except FileNotFoundError:
        return _empty_traders_doc()
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        logger.exception("traders: failed to parse R2 file")
        raise HTTPException(
            status_code=500, detail=f"Corrupt traders file: {exc}"
        )
    if not isinstance(data, dict) or not isinstance(data.get("features"), list):
        raise HTTPException(
            status_code=500,
            detail="Corrupt traders file (no features array)",
        )
    return data


def _save_traders_file(data: dict) -> None:
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    key = r2_storage.traders_live_key()
    r2_storage.upload_bytes(key, body, content_type="application/geo+json")
    r2_storage.invalidate_presigned_download_url(key)


# ---------------------------------------------------------------------------
# Duplicate scan
# ---------------------------------------------------------------------------

def _existing_points(data: dict) -> List[tuple]:
    """Flatten the live geojson into ``[(x, z, trader_id, trader_type)]``.
    Coords are in geojson space (Z stored as +south)."""
    out: List[tuple] = []
    for feat in data.get("features") or []:
        if not isinstance(feat, dict):
            continue
        geom = feat.get("geometry") or {}
        if geom.get("type") != "Point":
            continue
        coords = geom.get("coordinates") or []
        try:
            x = int(coords[0])
            z = int(coords[1])
        except (TypeError, ValueError, IndexError):
            continue
        props = feat.get("properties") or {}
        out.append((x, z, str(props.get("id") or ""), str(props.get("trader_type") or "")))
    return out


def _has_duplicate(
    px: int, pz: int, existing: List[tuple], radius: int = _DUPLICATE_RADIUS
) -> bool:
    r2 = radius * radius
    for ex, ez, _id, _t in existing:
        dx = ex - px
        dz = ez - pz
        if dx * dx + dz * dz <= r2:
            return True
    return False


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class TraderContributionItem(BaseModel):
    x: int
    z: int
    y: Optional[int] = None
    label: Optional[str] = None
    trader_type: str


class TraderContributionStats(BaseModel):
    """User-supplied (frontend-computed) batch stats. Stored verbatim on
    every accepted audit row for reviewer context. The frontend may
    populate any subset; missing keys default to 0."""

    chatlog_parsed_count: int = Field(0, ge=0)
    inferred_confidence_avg: float = Field(0.0, ge=0.0, le=1.0)
    # Mirrors the TL contribution flow: how many parsed chat-log trader
    # waypoints already matched a trader on the live map (within the
    # client-side dedupe radius), and the resulting "% of this batch that
    # was already known" percentage. Useful for reviewers to gauge whether
    # a chat-log upload is mostly noise vs. new coverage.
    existing_match_count: int = Field(0, ge=0)
    existing_match_pct: float = Field(0.0, ge=0.0, le=100.0)


class TraderContributionBody(BaseModel):
    traders: List[TraderContributionItem] = Field(..., min_length=1)
    source: str  # "chatlog" | "manual"
    stats: TraderContributionStats = TraderContributionStats()
    client_batch_id: Optional[str] = None


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("/contribute-traders")
async def contribute_traders(
    payload: TraderContributionBody,
    ctx: dict = Depends(require_active_user),
) -> dict:
    """Append user-contributed Traders to the live traders.geojson.

    Returns ``{accepted, duplicate_flagged_count, batch_id}``. Both chatlog
    and manual rows are always inserted; ``duplicate_flagged_count`` is the
    number that landed within ``_DUPLICATE_RADIUS`` of an existing trader.
    """
    user = _require_account_user(ctx)

    source = payload.source
    if source == "chatlog":
        if not feature_flags.is_feature_enabled_default(_CHATLOG_FLAG, False):
            raise HTTPException(status_code=503, detail=_flag_off_detail("chat-log"))
        daily_cap = _CHATLOG_MAX_PER_DAY
    elif source == "manual":
        if not feature_flags.is_feature_enabled_default(_MANUAL_FLAG, False):
            raise HTTPException(status_code=503, detail=_flag_off_detail("manual"))
        daily_cap = _MANUAL_MAX_PER_DAY
    else:
        raise HTTPException(
            status_code=400, detail="source must be 'chatlog' or 'manual'"
        )

    is_admin = bool((ctx.get("info") or {}).get("is_admin"))
    api_key_id = _ctx_api_key_id(ctx)

    # Daily cap (per-source) for non-admins. Counted off audit rows so the
    # window survives restarts and reflects accepted contributions exactly.
    if not is_admin and api_key_id:
        recent = await asyncio.to_thread(
            db.count_trader_submissions_in_window,
            actor_api_key_id=api_key_id,
            source=source,
            window_seconds=_DAY_SECONDS,
        )
        if recent >= daily_cap:
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "rate_limited",
                    "message": (
                        f"Daily {source} submission limit reached "
                        f"({daily_cap} per 24h)."
                    ),
                    "retry_after_seconds": _DAY_SECONDS,
                },
            )

    items = payload.traders
    if len(items) > _MAX_BATCH:
        raise HTTPException(
            status_code=400,
            detail=f"too many traders in one batch (max {_MAX_BATCH})",
        )

    # Validate up front so we never touch R2 on bad input.
    for idx, it in enumerate(items):
        for v, name in ((it.x, "x"), (it.z, "z")):
            if abs(int(v)) > _COORD_LIMIT:
                raise HTTPException(
                    status_code=400, detail=f"item {idx}: {name} out of range"
                )
        if it.trader_type not in _TRADER_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"item {idx}: unknown trader_type '{it.trader_type}'",
            )
        object.__setattr__(it, "label", _normalise_label(it.label))

    user_id = str(user["id"]) if user.get("id") is not None else None
    if not user_id:
        raise HTTPException(status_code=403, detail=_ACCOUNT_REQUIRED_DETAIL)
    display_name = user.get("display_name") or "Anonymous"

    batch_id = (payload.client_batch_id or str(uuid.uuid4()))[:64]
    now_iso = _now_iso()

    accepted: list = []  # list of (feature_dict, duplicate_flag)

    async with _traders_lock:
        data = await asyncio.to_thread(_load_traders_file)
        existing = _existing_points(data)

        for it in items:
            # Geojson stores +Z = south; frontend sends +Z = north.
            gx = int(it.x)
            gz = -int(it.z)
            is_dup = _has_duplicate(gx, gz, existing)
            trader_id = str(uuid.uuid4())
            feature = {
                "type": "Feature",
                "properties": {
                    "id": trader_id,
                    "label": it.label or "",
                    "trader_type": it.trader_type,
                    "source": source,
                    "tag": "user",
                    "origin": "user",
                    "added_by": display_name,
                    "added_by_user_id": user_id,
                    "added_at": now_iso,
                    "duplicate_flagged": is_dup,
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [gx, gz]
                    if it.y is None
                    else [gx, gz, int(it.y)],
                },
            }
            data["features"].append(feature)
            existing.append((gx, gz, trader_id, it.trader_type))
            accepted.append((feature, is_dup))

        if accepted:
            await asyncio.to_thread(_save_traders_file, data)

    duplicate_flagged_count = sum(1 for _, d in accepted if d)
    submission_stats = {
        "submitted_count": len(items),
        "accepted_count": len(accepted),
        "duplicate_flagged_count": duplicate_flagged_count,
        "batch_id": batch_id,
        "chatlog_parsed_count": int(payload.stats.chatlog_parsed_count),
        "inferred_confidence_avg": float(payload.stats.inferred_confidence_avg),
        "existing_match_count": int(payload.stats.existing_match_count),
        "existing_match_pct": float(payload.stats.existing_match_pct),
    }
    for feat, is_dup in accepted:
        await asyncio.to_thread(
            db.insert_trader_audit,
            trader_id=feat["properties"]["id"],
            action="add",
            actor_api_key_id=api_key_id,
            actor_display_name=display_name,
            source=source,
            trader_type=feat["properties"]["trader_type"],
            after_payload=feat,
            submission_stats=submission_stats,
            duplicate_flagged=is_dup,
        )

    return {
        "accepted": len(accepted),
        "duplicate_flagged_count": duplicate_flagged_count,
        "batch_id": batch_id,
    }


# ---------------------------------------------------------------------------
# Public read endpoints
# ---------------------------------------------------------------------------

@router.get("/traders/url")
async def get_traders_url(request: Request, api_key: str = Depends(verify_api_key)) -> dict:
    """Presigned download URL for the live traders.geojson. Returns
    ``{url: None, disabled: True}`` when the viewer flag is off, and
    ``{url: None, empty: True}`` when no traders have been contributed yet
    (no live file exists). Mirrors the shape returned by ``/landmarks/url``
    when present, so the frontend can use one fetcher."""
    if not feature_flags.is_feature_enabled_default(_VIEWER_FLAG, False):
        return {"url": None, "disabled": True}
    key = r2_storage.traders_live_key()
    if not r2_storage.object_exists(key):
        return {"url": None, "empty": True}
    url = r2_storage.generate_presigned_download_url(
        key,
        expires_seconds=7 * 24 * 60 * 60,
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
        "expires_in_seconds": int(7 * 24 * 60 * 60 * 0.75),
    }


@router.get("/traders/audit")
async def get_traders_audit() -> dict:
    """``{trader_id: {added_by, added_at, trader_type, source}}`` for every
    user-contributed trader currently present in the live geojson. Sourced
    from the most-recent add row per trader_id (admin-deleted rows are
    superseded by a later delete row). Public."""
    rows = await asyncio.to_thread(db.list_trader_audit_added_index)
    return {
        "traders": {
            tid: {
                "added_by": v.get("added_by"),
                "added_at": v.get("added_at"),
                "trader_type": v.get("trader_type"),
                "source": v.get("source"),
            }
            for tid, v in rows.items()
        }
    }


@router.get("/account/contribute-traders")
async def my_trader_contributions(
    ctx: dict = Depends(require_active_user),
    limit: int = 50,
    offset: int = 0,
) -> dict:
    user = _require_account_user(ctx)
    api_key_id = _ctx_api_key_id(ctx)
    if not api_key_id:
        return {"items": [], "total": 0, "stats": {}}
    stats = await asyncio.to_thread(db.get_trader_user_stats, api_key_id)
    page = await asyncio.to_thread(
        db.list_trader_add_audit_paginated,
        actor_api_key_id=api_key_id,
        limit=limit,
        offset=offset,
    )
    # Normalise datetime to iso for json.
    for r in page.get("items") or []:
        ts = r.get("created_at")
        if ts is not None and hasattr(ts, "isoformat"):
            r["created_at"] = ts.isoformat()
    return {
        "items": page.get("items") or [],
        "total": page.get("total") or 0,
        "stats": stats,
        "user_id": str(user["id"]),
    }

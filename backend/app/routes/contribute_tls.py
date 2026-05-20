"""User-contributed translocators endpoint.

POST /api/contribute-tls — append user-submitted TL pairs to the live
``translocators.geojson`` in R2 and write one audit row per accepted TL.

Mirrors the live-merge pattern of [backend/app/routes/landmarks.py]:
- account-required (no anonymous submissions),
- single-process asyncio lock around read-modify-upload of the geojson,
- hand-coded ``_normalise_label`` instead of a Pydantic validator so the
  error messages match the landmarks file 1:1,
- Z is **negated on the way in** (the geojson stores +Z = south, the
  frontend speaks +Z = north), matching the existing static seed data
  and how the landmarks endpoint flips Z on insert.

Gated by feature flag ``translocator_contributions`` (default OFF). When
the flag is OFF the endpoint returns 503 and the frontend Contribute TLs
page degrades to "backend not available yet".

Per-segment audit info (``added_by``, ``added_at``) lives in the geojson
``properties`` themselves so the TOPS map can render attribution without
an extra round-trip. The ``GET /api/translocators/audit`` endpoint exists
for richer history (deletes too) and for keying which segments to render
in the user-contributed colour.
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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_active_user
from ..core import database as db
from ..core import feature_flags
from ..core import r2_storage
from ..rate_limiter import check_scoped_rate_limit


logger = logging.getLogger("uvicorn.error")
router = APIRouter(tags=["contribute-tls"])

# Single-process serialisation of read-modify-upload of translocators.geojson.
# Shared with admin_translocators delete paths via attribute access.
_translocators_lock = asyncio.Lock()

# How long to wait for the DB-backed cross-process lease before giving up
# and surfacing a 503 to the client. The critical section is milliseconds
# so 15s of patience is generous.
_GEOJSON_LOCK_WAIT_SECONDS = 15.0
_GEOJSON_LOCK_POLL_SECONDS = 0.1


@contextlib.asynccontextmanager
async def translocators_write_lock(action: str):
    """Combine the in-process ``_translocators_lock`` with the DB-backed
    ``geojson_lock(resource='translocators')`` lease so two backend
    replicas cannot both read-modify-upload the geojson at the same time.

    Surfaces HTTP 503 when the cross-instance lease cannot be acquired
    within :data:`_GEOJSON_LOCK_WAIT_SECONDS` rather than blocking
    indefinitely — a stuck holder means something is wrong on the other
    side and the caller should retry instead of holding an HTTP worker.
    """
    async with _translocators_lock:
        token: Optional[str] = None
        deadline = time.monotonic() + _GEOJSON_LOCK_WAIT_SECONDS
        while True:
            try:
                token = await asyncio.to_thread(
                    db.try_acquire_geojson_lock, "translocators", action
                )
            except Exception:
                logger.exception("translocators: DB lock acquisition raised")
                raise HTTPException(
                    status_code=503,
                    detail="translocators lock backend unavailable; retry",
                )
            if token:
                break
            if time.monotonic() >= deadline:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "translocators.geojson is locked by another writer; "
                        "retry in a few seconds"
                    ),
                )
            await asyncio.sleep(_GEOJSON_LOCK_POLL_SECONDS)
        try:
            yield token
        finally:
            try:
                await asyncio.to_thread(
                    db.release_geojson_lock, "translocators", token
                )
            except Exception:
                logger.exception("translocators: DB lock release raised")

# Coordinate sanity limits. Same as landmarks.py.
_COORD_LIMIT = 4_000_000

# Default per-batch cap. Even a power-user importing a long-played server
# should fit easily under this — anything larger is more likely a
# malformed upload than a real submission. Admin-overridable via the
# ``translocators_max_batch`` feature flag.
_MAX_BATCH_DEFAULT = 200
_MAX_BATCH_FLAG = "translocators_max_batch"

# Default server-side dedupe radius (blocks). A submitted TL whose
# endpoints both fall within this many blocks of the SAME existing
# segment (orientation-agnostic) is treated as already present and
# silently skipped. Matches the frontend's ``EXISTING_MATCH_RADIUS`` so
# the FE-flagged ``existing`` pairs are also caught here as a
# trust-but-verify safety net. Admin-overridable via the
# ``translocators_dedupe_radius`` feature flag.
_EXISTING_DEDUPE_RADIUS_DEFAULT = 200
_EXISTING_DEDUPE_RADIUS_FLAG = "translocators_dedupe_radius"

# Label is short user-controlled text. Allow newlines (existing seed data has
# them) and a generous length cap to discourage abuse / griefing.
_LABEL_MAX_LEN = 200

_FLAG_KEY = "translocator_contributions"

# Per-user daily cap on chat-log batch submissions. Admins (env-var
# ``ADMIN_API_KEY`` or DB ``is_admin``) bypass. Default value below;
# admin-overridable via the ``translocators_chatlog_daily_cap`` flag.
_BATCH_RATE_SCOPE = "contribute-tls-batch"
_BATCH_RATE_MAX_DEFAULT = 3
_BATCH_RATE_MAX_FLAG = "translocators_chatlog_daily_cap"
_BATCH_RATE_WINDOW = 86400  # 24 hours

_ACCOUNT_REQUIRED_DETAIL = {
    "code": "account_required",
    "message": "Create an account to contribute translocators.",
}

_FLAG_OFF_DETAIL = {
    "code": "feature_disabled",
    "message": "Translocator contributions are currently disabled.",
}


# ---------------------------------------------------------------------------
# Helpers (label / context — kept local to avoid coupling to landmarks.py)
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalise_label(raw: Optional[str]) -> str:
    """Trim, normalise newlines, reject control chars. Empty string OK
    (TL labels are routinely blank in the seed data)."""
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
    """``require_active_user`` permits the synthetic admin (no users row).
    For contribute we require a real account so the audit row carries a
    real ``added_by_user_id``."""
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

def _load_translocators_file() -> dict:
    """Download + parse the live translocators.geojson from R2."""
    key = r2_storage.translocators_live_key()
    try:
        raw = r2_storage.download_bytes(key)
    except FileNotFoundError:
        raise HTTPException(
            status_code=503,
            detail="translocators.geojson missing from R2; run the migration script.",
        )
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        logger.exception("translocators: failed to parse R2 file")
        raise HTTPException(
            status_code=500, detail=f"Corrupt translocators file: {exc}"
        )
    if not isinstance(data, dict) or not isinstance(data.get("features"), list):
        raise HTTPException(
            status_code=500,
            detail="Corrupt translocators file (no features array)",
        )
    return data


def _save_translocators_file(data: dict) -> None:
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    key = r2_storage.translocators_live_key()
    r2_storage.upload_bytes(key, body, content_type="application/geo+json")
    r2_storage.invalidate_presigned_download_url(key)


# ---------------------------------------------------------------------------
# Existing-segment dedupe
# ---------------------------------------------------------------------------

def _existing_segments(data: dict) -> List[tuple]:
    """Flatten the live geojson into ``[(x1, z1, x2, z2)]`` tuples in
    geojson space (i.e. Z is the stored +south value, NOT negated)."""
    out: List[tuple] = []
    for feat in data.get("features") or []:
        if not isinstance(feat, dict):
            continue
        geom = feat.get("geometry") or {}
        if geom.get("type") != "LineString":
            continue
        coords = geom.get("coordinates") or []
        for i in range(1, len(coords)):
            try:
                x1, z1 = int(coords[i - 1][0]), int(coords[i - 1][1])
                x2, z2 = int(coords[i][0]), int(coords[i][1])
            except (TypeError, ValueError, IndexError):
                continue
            out.append((x1, z1, x2, z2))
    return out


def _segment_endpoints_overlap(
    a: tuple, b: tuple, *, radius: Optional[int] = None,
) -> bool:
    """Orientation-agnostic check: do segment ``a``'s endpoints both fall
    within ``radius`` blocks of segment ``b``'s endpoints?"""
    if radius is None:
        radius = feature_flags.get_int(
            _EXISTING_DEDUPE_RADIUS_FLAG, _EXISTING_DEDUPE_RADIUS_DEFAULT
        )
    ax1, az1, ax2, az2 = a
    bx1, bz1, bx2, bz2 = b
    r2 = radius * radius

    def near(x1: int, z1: int, x2: int, z2: int) -> bool:
        dx = x1 - x2
        dz = z1 - z2
        return dx * dx + dz * dz <= r2

    fwd = near(ax1, az1, bx1, bz1) and near(ax2, az2, bx2, bz2)
    rev = near(ax1, az1, bx2, bz2) and near(ax2, az2, bx1, bz1)
    return fwd or rev


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class TLContributionItem(BaseModel):
    x1: int
    z1: int
    x2: int
    z2: int
    label: Optional[str] = None


class TLContributionStats(BaseModel):
    """User-supplied (frontend-computed) batch statistics. Trusted as-is
    and stored verbatim on every audit row of the batch for reviewer
    context."""

    existing_match_pct: float = Field(..., ge=0.0, le=100.0)
    existing_pair_count: int = Field(..., ge=0)


class TLContributionBody(BaseModel):
    translocators: List[TLContributionItem] = Field(..., min_length=1)
    stats: TLContributionStats
    client_batch_id: Optional[str] = None


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("/contribute-tls")
async def contribute_translocators(
    payload: TLContributionBody,
    ctx: dict = Depends(require_active_user),
) -> dict:
    """Append user-contributed TL pairs to the live translocators.geojson.

    Returns ``{accepted, skipped_existing, batch_id}``. ``skipped_existing``
    counts submitted pairs whose endpoints both overlap an existing
    segment within the admin-configured dedupe radius (see
    ``translocators_dedupe_radius`` flag) — these are silently dropped
    (no geojson change, no audit row).
    """
    if not feature_flags.is_feature_enabled_default(_FLAG_KEY, False):
        raise HTTPException(status_code=503, detail=_FLAG_OFF_DETAIL)

    user = _require_account_user(ctx)

    # Daily cap for non-admin callers. Admins bypass so they can backfill /
    # test without burning a slot. Counts each ``POST /contribute-tls`` call
    # regardless of how many segments were ultimately accepted — the limit
    # is on submissions (the expensive read-modify-upload of R2), not pairs.
    is_admin = bool((ctx.get("info") or {}).get("is_admin"))
    if not is_admin:
        check_scoped_rate_limit(
            ctx["key"],
            _BATCH_RATE_SCOPE,
            feature_flags.get_int(_BATCH_RATE_MAX_FLAG, _BATCH_RATE_MAX_DEFAULT),
            _BATCH_RATE_WINDOW,
        )

    items = payload.translocators
    max_batch = feature_flags.get_int(_MAX_BATCH_FLAG, _MAX_BATCH_DEFAULT)
    if len(items) > max_batch:
        raise HTTPException(
            status_code=400,
            detail=f"too many translocators in one batch (max {max_batch})",
        )

    # Validate coords + label up front so we never touch R2 on bad input.
    for idx, it in enumerate(items):
        for v, name in (
            (it.x1, "x1"),
            (it.z1, "z1"),
            (it.x2, "x2"),
            (it.z2, "z2"),
        ):
            if abs(int(v)) > _COORD_LIMIT:
                raise HTTPException(
                    status_code=400,
                    detail=f"item {idx}: {name} out of range",
                )
        if it.x1 == it.x2 and it.z1 == it.z2:
            raise HTTPException(
                status_code=400,
                detail=f"item {idx}: endpoints are identical",
            )
        # Mutate via __setattr__ for Pydantic v2: validate / normalise label
        object.__setattr__(it, "label", _normalise_label(it.label))

    api_key_id = _ctx_api_key_id(ctx)
    user_id = str(user["id"]) if user.get("id") is not None else None
    if not user_id:
        # Unreachable due to _require_account_user, but defensive.
        raise HTTPException(status_code=403, detail=_ACCOUNT_REQUIRED_DETAIL)
    display_name = user.get("display_name") or "Anonymous"

    batch_id = (payload.client_batch_id or str(uuid.uuid4()))[:64]
    now_iso = _now_iso()

    accepted_features: list = []
    skipped_existing = 0

    async with translocators_write_lock("contribute"):
        data = await asyncio.to_thread(_load_translocators_file)
        existing = _existing_segments(data)

        for it in items:
            # Geojson stores +Z = south; frontend sends world Z (+Z = north).
            # Negate on the way in so the live file stays self-consistent
            # with the seed data (and existing readers).
            geo = (
                int(it.x1),
                -int(it.z1),
                int(it.x2),
                -int(it.z2),
            )
            if any(_segment_endpoints_overlap(geo, e) for e in existing):
                skipped_existing += 1
                continue

            segment_id = str(uuid.uuid4())
            feature = {
                "type": "Feature",
                "properties": {
                    "id": segment_id,
                    "label": it.label or "",
                    "depth1": 0,
                    "depth2": 0,
                    "tag": "user",
                    "origin": "user",
                    "added_by": display_name,
                    "added_by_user_id": user_id,
                    "added_at": now_iso,
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [
                        [geo[0], geo[1]],
                        [geo[2], geo[3]],
                    ],
                },
            }
            data["features"].append(feature)
            existing.append(geo)  # so within-batch duplicates also dedupe
            accepted_features.append(feature)

        if accepted_features:
            await asyncio.to_thread(_save_translocators_file, data)

    # Audit rows outside the lock — ordering is preserved by created_at.
    submission_stats = {
        "existing_match_pct": float(payload.stats.existing_match_pct),
        "existing_pair_count": int(payload.stats.existing_pair_count),
        "submitted_count": len(items),
        "accepted_count": len(accepted_features),
        "skipped_existing": skipped_existing,
        "batch_id": batch_id,
    }
    for feat in accepted_features:
        await asyncio.to_thread(
            db.insert_translocator_audit,
            segment_id=feat["properties"]["id"],
            action="add",
            actor_api_key_id=api_key_id,
            actor_display_name=display_name,
            after_payload=feat,
            submission_stats=submission_stats,
        )

    return {
        "accepted": len(accepted_features),
        "skipped_existing": skipped_existing,
        "batch_id": batch_id,
    }


# ---------------------------------------------------------------------------
# Public audit lookup (TOPS map hover + colouring)
# ---------------------------------------------------------------------------

@router.get("/translocators/audit")
async def get_translocators_audit() -> dict:
    """Return ``{segment_id: {added_by, added_at}}`` for every
    user-contributed translocator currently present in the live geojson.

    Sourced from the most recent ``add`` row per segment_id in
    ``translocators_audit``; admin-deleted segments are excluded by
    construction (the more recent ``delete`` row supersedes the ``add``).

    Public — same trust model as ``GET /translocators/url``.
    """
    rows = await asyncio.to_thread(db.list_translocator_audit_added_index)
    # Strip internal fields before sending to the client.
    return {
        "segments": {
            sid: {"added_by": v.get("added_by"), "added_at": v.get("added_at")}
            for sid, v in rows.items()
        }
    }


# Caller-facing self-history.
@router.get("/account/contribute-tls")
async def my_translocator_contributions(
    ctx: dict = Depends(require_active_user),
) -> dict:
    """List the caller's own submitted translocators (most recent first)."""
    user = _require_account_user(ctx)  # noqa: F841 — assert account exists
    api_key_id = _ctx_api_key_id(ctx)
    if not api_key_id:
        return {"contributions": []}
    rows = await asyncio.to_thread(
        db.list_translocator_audit,
        actor_api_key_id=api_key_id,
        action="add",
        limit=500,
    )
    out = []
    for r in rows:
        feat = r.get("after_payload") or {}
        props = (feat.get("properties") or {}) if isinstance(feat, dict) else {}
        coords = (
            ((feat.get("geometry") or {}).get("coordinates") or [])
            if isinstance(feat, dict)
            else []
        )
        created = r.get("created_at")
        out.append({
            "segment_id": r.get("segment_id"),
            "label": props.get("label"),
            "coordinates": coords,
            "submission_stats": r.get("submission_stats"),
            "created_at": (
                created.isoformat() if hasattr(created, "isoformat") else created
            ),
        })
    return {"contributions": out}

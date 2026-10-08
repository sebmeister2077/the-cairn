"""Public ingestion endpoint for "Save this route" actions from the
frontend route planner.

Each accepted request either inserts a new row into ``saved_routes`` or
bumps the ``save_count`` of an existing match (24h soft-dedup keyed on
identity + route signature). A mirror row is written into
``usage_events`` only on the *insert* path so the admin Usage timeline
counts distinct route-save events, not the bump traffic.

Anonymous saves are allowed. Per-IP and per-key rate limits guard
against abuse.
"""

from __future__ import annotations

import logging
import math
import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException, Request

from ..auth import _get_client_ip, _hash_ip, resolve_key_id
from ..core import planned_routes_db, saved_routes_db, usage_events
from ..rate_limiter import check_scoped_rate_limit


logger = logging.getLogger("uvicorn.error")

router = APIRouter(prefix="/route-analytics", tags=["route-analytics"])


# ---------------------------------------------------------------------------
# Validation constants
# ---------------------------------------------------------------------------

_COORD_MIN = -2_000_000
_COORD_MAX = 2_000_000
_MAX_LEGS = 200            # walks + tls combined
_MAX_TL_HOPS = 50
_MAX_LABEL_LEN = 120
_MAX_TOTAL_SECONDS = 7 * 24 * 3600.0   # one week ceiling
_MAX_BLOCKS = 10_000_000.0

_LABEL_STRIP_RE = re.compile(r"[\x00-\x1f<>]")

_IP_RATE_MAX = 20
_IP_RATE_WINDOW = 3600
_KEY_RATE_MAX = 60
_KEY_RATE_WINDOW = 3600


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _coerce_point(raw: Any, field: str) -> Dict[str, int]:
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail=f"{field} must be an object")
    try:
        x = int(round(float(raw.get("x"))))
        z = int(round(float(raw.get("z"))))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"{field} must have numeric x/z") from exc
    if not (_COORD_MIN <= x <= _COORD_MAX and _COORD_MIN <= z <= _COORD_MAX):
        raise HTTPException(status_code=400, detail=f"{field} out of range")
    return {"x": x, "z": z}


def _coerce_label(raw: Any) -> Optional[str]:
    if raw is None:
        return None
    if not isinstance(raw, str):
        return None
    cleaned = _LABEL_STRIP_RE.sub("", raw).strip()
    if not cleaned:
        return None
    return cleaned[:_MAX_LABEL_LEN]


def _coerce_legs(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail="legs must be a list")
    if not raw or len(raw) > _MAX_LEGS:
        raise HTTPException(
            status_code=400,
            detail=f"legs must contain 1..{_MAX_LEGS} entries",
        )
    cleaned: List[Dict[str, Any]] = []
    tl_count = 0
    for leg in raw:
        if not isinstance(leg, dict):
            raise HTTPException(status_code=400, detail="each leg must be an object")
        kind = leg.get("kind")
        if kind not in ("walk", "tl"):
            raise HTTPException(status_code=400, detail="leg.kind must be 'walk' or 'tl'")
        fr = _coerce_point(leg.get("from"), "leg.from")
        to = _coerce_point(leg.get("to"), "leg.to")
        try:
            seconds = float(leg.get("seconds"))
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="leg.seconds must be numeric") from exc
        if not (0 <= seconds <= _MAX_TOTAL_SECONDS):
            raise HTTPException(status_code=400, detail="leg.seconds out of range")
        entry: Dict[str, Any] = {
            "kind": kind,
            "from": fr,
            "to": to,
            "seconds": seconds,
        }
        if kind == "walk":
            try:
                blocks = float(leg.get("blocks"))
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=400, detail="walk leg.blocks must be numeric") from exc
            if not (0 <= blocks <= _MAX_BLOCKS):
                raise HTTPException(status_code=400, detail="walk leg.blocks out of range")
            entry["blocks"] = blocks
        else:
            tl_count += 1
            tl_id = leg.get("tlId")
            if isinstance(tl_id, str) and len(tl_id) <= 64:
                entry["tlId"] = tl_id
        cleaned.append(entry)
    if tl_count > _MAX_TL_HOPS:
        raise HTTPException(
            status_code=400,
            detail=f"too many TL hops (max {_MAX_TL_HOPS})",
        )
    return cleaned


@router.post("/save")
async def save_route(
    request: Request,
    payload: dict,
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
) -> dict:
    """Save a single computed route for road-worker analytics."""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid payload")

    fr = _coerce_point(payload.get("from"), "from")
    to = _coerce_point(payload.get("to"), "to")
    from_label = _coerce_label(payload.get("from_label"))
    to_label = _coerce_label(payload.get("to_label"))

    try:
        total_seconds = float(payload.get("total_seconds"))
        walk_blocks = float(payload.get("walk_blocks"))
        tl_hops_decl = int(payload.get("tl_hops"))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="totals must be numeric") from exc
    if not (0 < total_seconds <= _MAX_TOTAL_SECONDS):
        raise HTTPException(status_code=400, detail="total_seconds out of range")
    if not (0 <= walk_blocks <= _MAX_BLOCKS):
        raise HTTPException(status_code=400, detail="walk_blocks out of range")
    if not (0 <= tl_hops_decl <= _MAX_TL_HOPS):
        raise HTTPException(status_code=400, detail="tl_hops out of range")

    legs = _coerce_legs(payload.get("legs"))
    actual_tl_hops = sum(1 for leg in legs if leg["kind"] == "tl")
    if actual_tl_hops != tl_hops_decl:
        # Trust the legs over the declared total — the frontend may
        # round, but the legs are authoritative.
        tl_hops_decl = actual_tl_hops

    walk_speed = payload.get("walk_speed")
    tl_penalty_seconds = payload.get("tl_penalty_seconds")
    k_neighbors = payload.get("k_neighbors")
    try:
        walk_speed_f = float(walk_speed) if walk_speed is not None else None
        tl_penalty_f = (
            float(tl_penalty_seconds) if tl_penalty_seconds is not None else None
        )
        k_neighbors_i = int(k_neighbors) if k_neighbors is not None else None
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="cost model fields invalid") from exc

    client_ip = _get_client_ip(request)
    ip_hash = _hash_ip(client_ip)

    # Per-IP throttle first — runs even for signed-in users so a leaked
    # key from one address still can't pummel the table.
    check_scoped_rate_limit(
        ip_hash, "route-analytics-save", _IP_RATE_MAX, _IP_RATE_WINDOW
    )

    actor_id: Optional[str] = None
    if x_api_key:
        try:
            resolved = resolve_key_id(x_api_key)
            if resolved is not None:
                actor_id = str(resolved)
                check_scoped_rate_limit(
                    actor_id,
                    "route-analytics-save-key",
                    _KEY_RATE_MAX,
                    _KEY_RATE_WINDOW,
                )
        except HTTPException:
            raise
        except Exception:  # pragma: no cover — never block on resolve failure
            actor_id = None

    tl_hop_sequence = saved_routes_db.build_tl_hop_sequence(legs)
    route_signature = saved_routes_db.compute_route_signature(
        fr["x"], fr["z"], to["x"], to["z"], tl_hop_sequence
    )
    straight_line_blocks = saved_routes_db.euclidean(
        fr["x"], fr["z"], to["x"], to["z"]
    )

    try:
        status, row_id, save_count = saved_routes_db.insert_or_bump(
            actor_api_key_id=actor_id,
            ip_hash=ip_hash,
            from_x=fr["x"],
            from_z=fr["z"],
            to_x=to["x"],
            to_z=to["z"],
            from_label=from_label,
            to_label=to_label,
            total_seconds=total_seconds,
            walk_blocks=walk_blocks,
            tl_hops=tl_hops_decl,
            walk_speed=walk_speed_f,
            tl_penalty_seconds=tl_penalty_f,
            k_neighbors=k_neighbors_i,
            tl_hop_sequence=tl_hop_sequence,
            route_signature=route_signature,
            legs=legs,
            straight_line_blocks=straight_line_blocks,
        )
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Database not configured")
    except Exception as exc:
        logger.exception("saved_routes insert_or_bump failed: %s", exc)
        raise HTTPException(status_code=500, detail="failed to save route") from exc

    # Mirror into usage_events ONLY on first insert. Counting bumps would
    # double-count repeat saves against the dashboard's timeline.
    if status == "inserted":
        usage_events.record(
            "route.saved",
            actor_api_key_id=actor_id,
            category="route",
            metadata={
                "row_id": row_id,
                "tl_hops": tl_hops_decl,
                "total_seconds": int(total_seconds),
                "walk_blocks": int(walk_blocks),
                "signature": route_signature,
            },
            ip_hash=ip_hash,
        )

    return {
        "status": status,
        "save_count": save_count,
    }


# ---------------------------------------------------------------------------
# /plan — record a *completed* route-planner computation for usage analytics.
# ---------------------------------------------------------------------------


_VALID_SOURCES = planned_routes_db.VALID_SOURCES
_VALID_MODES = planned_routes_db.VALID_MODES
_SETTING_KEYS = planned_routes_db.SETTING_KEYS
_MAX_ALTERNATIVES = 50


def _coerce_source(raw: Any) -> Optional[str]:
    if isinstance(raw, str) and raw in _VALID_SOURCES:
        return raw
    return None


def _coerce_settings(raw: Any) -> Dict[str, Any]:
    """Keep only recognised, non-default setting keys with sane scalar values."""
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Any] = {}
    for key in _SETTING_KEYS:
        if key not in raw:
            continue
        val = raw[key]
        if key == "elk_friendly_only":
            out[key] = bool(val)
        elif key in ("rendezvous_objective", "search_detail"):
            if isinstance(val, str) and len(val) <= 32:
                out[key] = _LABEL_STRIP_RE.sub("", val).strip()[:32]
        else:
            try:
                num = float(val)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(num) or abs(num) > 1_000_000:
                continue
            out[key] = int(num) if float(num).is_integer() else num
    return out


@router.post("/plan")
async def plan_route(
    request: Request,
    payload: dict,
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
) -> dict:
    """Record one completed route-planner computation (route or rendezvous)."""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid payload")

    mode = payload.get("mode")
    if mode not in _VALID_MODES:
        mode = "route"

    fr = _coerce_point(payload.get("from"), "from")
    to = _coerce_point(payload.get("to"), "to")
    from_label = _coerce_label(payload.get("from_label"))
    to_label = _coerce_label(payload.get("to_label"))
    from_source = _coerce_source(payload.get("from_source"))
    to_source = _coerce_source(payload.get("to_source"))

    try:
        total_seconds = float(payload.get("total_seconds"))
        walk_blocks = float(payload.get("walk_blocks"))
        tl_hops_decl = int(payload.get("tl_hops"))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="totals must be numeric") from exc
    if not (0 < total_seconds <= _MAX_TOTAL_SECONDS):
        raise HTTPException(status_code=400, detail="total_seconds out of range")
    if not (0 <= walk_blocks <= _MAX_BLOCKS):
        raise HTTPException(status_code=400, detail="walk_blocks out of range")
    if not (0 <= tl_hops_decl <= _MAX_TL_HOPS):
        raise HTTPException(status_code=400, detail="tl_hops out of range")

    legs = _coerce_legs(payload.get("legs"))
    actual_tl_hops = sum(1 for leg in legs if leg["kind"] == "tl")
    if actual_tl_hops != tl_hops_decl:
        tl_hops_decl = actual_tl_hops

    walk_speed = payload.get("walk_speed")
    tl_penalty_seconds = payload.get("tl_penalty_seconds")
    k_neighbors = payload.get("k_neighbors")
    number_of_routes = payload.get("number_of_routes")
    elk_friendly_only = payload.get("elk_friendly_only")
    try:
        walk_speed_f = float(walk_speed) if walk_speed is not None else None
        tl_penalty_f = (
            float(tl_penalty_seconds) if tl_penalty_seconds is not None else None
        )
        k_neighbors_i = int(k_neighbors) if k_neighbors is not None else None
        number_of_routes_i = (
            int(number_of_routes) if number_of_routes is not None else None
        )
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="cost model fields invalid") from exc
    elk_friendly_b = (
        bool(elk_friendly_only) if elk_friendly_only is not None else None
    )

    settings = _coerce_settings(payload.get("settings"))

    selected_index: Optional[int] = None
    num_alternatives: Optional[int] = None
    try:
        if payload.get("selected_index") is not None:
            selected_index = int(payload.get("selected_index"))
        if payload.get("num_alternatives") is not None:
            num_alternatives = int(payload.get("num_alternatives"))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="selection fields invalid") from exc
    if selected_index is not None and not (0 <= selected_index <= _MAX_ALTERNATIVES):
        raise HTTPException(status_code=400, detail="selected_index out of range")
    if num_alternatives is not None and not (0 <= num_alternatives <= _MAX_ALTERNATIVES):
        raise HTTPException(status_code=400, detail="num_alternatives out of range")

    client_ip = _get_client_ip(request)
    ip_hash = _hash_ip(client_ip)

    check_scoped_rate_limit(
        ip_hash, "route-analytics-plan", _IP_RATE_MAX, _IP_RATE_WINDOW
    )

    actor_id: Optional[str] = None
    if x_api_key:
        try:
            resolved = resolve_key_id(x_api_key)
            if resolved is not None:
                actor_id = str(resolved)
                check_scoped_rate_limit(
                    actor_id,
                    "route-analytics-plan-key",
                    _KEY_RATE_MAX,
                    _KEY_RATE_WINDOW,
                )
        except HTTPException:
            raise
        except Exception:  # pragma: no cover — never block on resolve failure
            actor_id = None

    tl_hop_sequence = saved_routes_db.build_tl_hop_sequence(legs)
    route_signature = saved_routes_db.compute_route_signature(
        fr["x"], fr["z"], to["x"], to["z"], tl_hop_sequence
    )
    straight_line_blocks = saved_routes_db.euclidean(
        fr["x"], fr["z"], to["x"], to["z"]
    )

    try:
        status, row_id, plan_count = planned_routes_db.insert_or_bump(
            actor_api_key_id=actor_id,
            ip_hash=ip_hash,
            mode=mode,
            from_x=fr["x"],
            from_z=fr["z"],
            to_x=to["x"],
            to_z=to["z"],
            from_label=from_label,
            to_label=to_label,
            from_source=from_source,
            to_source=to_source,
            total_seconds=total_seconds,
            walk_blocks=walk_blocks,
            tl_hops=tl_hops_decl,
            walk_speed=walk_speed_f,
            tl_penalty_seconds=tl_penalty_f,
            k_neighbors=k_neighbors_i,
            number_of_routes=number_of_routes_i,
            elk_friendly_only=elk_friendly_b,
            settings=settings,
            selected_index=selected_index,
            num_alternatives=num_alternatives,
            tl_hop_sequence=tl_hop_sequence,
            route_signature=route_signature,
            legs=legs,
            straight_line_blocks=straight_line_blocks,
        )
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Database not configured")
    except Exception as exc:
        logger.exception("planned_routes insert_or_bump failed: %s", exc)
        raise HTTPException(status_code=500, detail="failed to record plan") from exc

    # Mirror into usage_events ONLY on first insert to avoid double-counting.
    if status == "inserted":
        usage_events.record(
            "route.planned",
            actor_api_key_id=actor_id,
            category="route",
            metadata={
                "row_id": row_id,
                "mode": mode,
                "from_source": from_source,
                "to_source": to_source,
                "non_default_settings": settings,
                "selected_index": selected_index,
                "num_alternatives": num_alternatives,
                "tl_hops": tl_hops_decl,
            },
            ip_hash=ip_hash,
        )

    return {"status": status, "plan_count": plan_count}


# ---------------------------------------------------------------------------
# /interaction — lightweight route-planner interaction events.
# ---------------------------------------------------------------------------


_INTERACTION_TYPES = {"segment_focused", "selected"}
_INTERACTION_IP_RATE_MAX = 120
_INTERACTION_IP_RATE_WINDOW = 3600


@router.post("/interaction")
async def record_interaction(
    request: Request,
    payload: dict,
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
) -> dict:
    """Record a small route-planner interaction (segment focus / route switch)."""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid payload")

    kind = payload.get("type")
    if kind not in _INTERACTION_TYPES:
        raise HTTPException(status_code=400, detail="invalid interaction type")

    metadata: Dict[str, Any] = {}
    if kind == "segment_focused":
        leg_kind = payload.get("leg_kind")
        if leg_kind not in ("walk", "tl"):
            raise HTTPException(status_code=400, detail="leg_kind must be 'walk' or 'tl'")
        metadata["leg_kind"] = leg_kind
    else:  # selected
        try:
            selected_index = int(payload.get("selected_index"))
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="selected_index must be numeric") from exc
        if not (0 <= selected_index <= _MAX_ALTERNATIVES):
            raise HTTPException(status_code=400, detail="selected_index out of range")
        metadata["selected_index"] = selected_index
        num_alternatives = payload.get("num_alternatives")
        if num_alternatives is not None:
            try:
                num_alternatives = int(num_alternatives)
            except (TypeError, ValueError) as exc:
                raise HTTPException(
                    status_code=400, detail="num_alternatives must be numeric"
                ) from exc
            if 0 <= num_alternatives <= _MAX_ALTERNATIVES:
                metadata["num_alternatives"] = num_alternatives

    client_ip = _get_client_ip(request)
    ip_hash = _hash_ip(client_ip)
    check_scoped_rate_limit(
        ip_hash,
        "route-analytics-interaction",
        _INTERACTION_IP_RATE_MAX,
        _INTERACTION_IP_RATE_WINDOW,
    )

    actor_id: Optional[str] = None
    if x_api_key:
        try:
            resolved = resolve_key_id(x_api_key)
            if resolved is not None:
                actor_id = str(resolved)
        except HTTPException:
            raise
        except Exception:  # pragma: no cover
            actor_id = None

    usage_events.record(
        f"route.{kind}",
        actor_api_key_id=actor_id,
        category="route",
        metadata=metadata,
        ip_hash=ip_hash,
    )

    return {"status": "recorded"}

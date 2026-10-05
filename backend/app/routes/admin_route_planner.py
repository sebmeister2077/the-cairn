"""Admin "Route Planner" analytics — read-only endpoints.

All routes are protected by :func:`app.auth.require_admin` and live under
``/api/admin/route-planner``. Aggregations run against the
``planned_routes`` fact table (migration ``0048_planned_routes``,
populated by ``POST /api/route-analytics/plan``) plus ``usage_events`` for
the lightweight interaction counters (segment focus / route switches).

The dashboard is **read-only**. No endpoint here mutates state.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import logging
import threading
import time
from typing import Any, Dict, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth import require_admin
from ..core import database as db
from ..core import planned_routes_db


logger = logging.getLogger("uvicorn.error")

router = APIRouter(prefix="/admin/route-planner", tags=["admin-route-planner"])


_MAX_WINDOW_DAYS = 180
_DEFAULT_WINDOW_DAYS = 30
_VALID_GRANULARITIES = {"hour", "day", "week"}
_CACHE_TTL_SECONDS = 60.0


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"invalid datetime: {exc}") from exc


def _resolve_window(
    frm: Optional[str], to: Optional[str]
) -> Tuple[datetime, datetime]:
    end = _parse_iso(to) or datetime.now(timezone.utc)
    start = _parse_iso(frm) or (end - timedelta(days=_DEFAULT_WINDOW_DAYS))
    if start >= end:
        raise HTTPException(status_code=400, detail="`from` must be before `to`")
    if (end - start) > timedelta(days=_MAX_WINDOW_DAYS):
        raise HTTPException(
            status_code=400,
            detail=f"window may not exceed {_MAX_WINDOW_DAYS} days",
        )
    return start, end


def _resolve_granularity(value: str) -> str:
    if value not in _VALID_GRANULARITIES:
        raise HTTPException(
            status_code=400,
            detail=f"granularity must be one of {sorted(_VALID_GRANULARITIES)}",
        )
    return value


_cache_lock = threading.Lock()
_cache: Dict[Tuple, Tuple[float, Any]] = {}
_CACHE_MAX_ENTRIES = 128


def _cache_get(key: Tuple) -> Optional[Any]:
    with _cache_lock:
        entry = _cache.get(key)
        if entry is None:
            return None
        ts, value = entry
        if (time.monotonic() - ts) > _CACHE_TTL_SECONDS:
            _cache.pop(key, None)
            return None
        return value


def _cache_put(key: Tuple, value: Any) -> None:
    with _cache_lock:
        if len(_cache) >= _CACHE_MAX_ENTRIES:
            for k in sorted(_cache, key=lambda k: _cache[k][0])[: _CACHE_MAX_ENTRIES // 2]:
                _cache.pop(k, None)
        _cache[key] = (time.monotonic(), value)


def _iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _ensure_db() -> None:
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")


def _interaction_counts(start: datetime, end: datetime) -> Dict[str, int]:
    """Count lightweight route interactions from ``usage_events``."""
    out = {"segment_focused": 0, "selected": 0}
    if not db.is_available():
        return out
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT event_type, COUNT(*)::bigint
                     FROM usage_events
                    WHERE created_at >= %s AND created_at < %s
                      AND event_type IN ('route.segment_focused', 'route.selected')
                 GROUP BY event_type""",
                (start, end),
            )
            for event_type, count in cur.fetchall():
                key = event_type.split(".", 1)[-1]
                if key in out:
                    out[key] = int(count)
    return out


@router.get("")
async def route_planner_bundle(
    _: str = Depends(require_admin),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    granularity: str = Query("day"),
    top_limit: int = Query(20, ge=1, le=100),
    heatmap_cell: int = Query(128, ge=16, le=1024),
) -> dict:
    """Bundle of aggregations powering the admin "Route Planner" audit page."""
    _ensure_db()
    start, end = _resolve_window(frm, to)
    gran = _resolve_granularity(granularity)
    cache_key = ("rp_bundle", _iso(start), _iso(end), gran, top_limit, heatmap_cell)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    payload = {
        "from": _iso(start),
        "to": _iso(end),
        "granularity": gran,
        "summary": planned_routes_db.summary(start, end),
        "timeline": planned_routes_db.timeline(start, end, gran),
        "source_breakdown": planned_routes_db.source_breakdown(start, end),
        "settings_breakdown": planned_routes_db.settings_breakdown(start, end),
        "selected_rank_breakdown": planned_routes_db.selected_rank_breakdown(start, end),
        "interaction_counts": _interaction_counts(start, end),
        "top_routes": planned_routes_db.top_routes(start, end, top_limit),
        "top_tl_edges": planned_routes_db.top_tl_edges(start, end, top_limit),
        "endpoint_heatmap": planned_routes_db.endpoint_heatmap(start, end, heatmap_cell),
    }
    _cache_put(cache_key, payload)
    return payload


@router.get("/map")
async def route_planner_map(
    _: str = Depends(require_admin),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    heatmap_cell: int = Query(128, ge=16, le=1024),
    flow_limit: int = Query(400, ge=1, le=2000),
) -> dict:
    """Endpoint density + weighted route-flow segments for the map overlay."""
    _ensure_db()
    start, end = _resolve_window(frm, to)
    cache_key = ("rp_map", _iso(start), _iso(end), heatmap_cell, flow_limit)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    payload = {
        "from": _iso(start),
        "to": _iso(end),
        "endpoint_heatmap": planned_routes_db.endpoint_heatmap(start, end, heatmap_cell),
        "route_flows": planned_routes_db.route_flows(start, end, flow_limit),
    }
    _cache_put(cache_key, payload)
    return payload

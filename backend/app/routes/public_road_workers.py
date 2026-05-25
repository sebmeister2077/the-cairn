"""Always-public, unlisted endpoint that surfaces aggregated route-planner
analytics so road maintainers can prioritise tunnel work and signage.

No token gating: anyone with the URL can hit this. We:
  * Heavily rate-limit per IP to discourage scraping.
  * Cache the response in-process for a short window.
  * Strip identifying fields (no actor key, no IP hash, no per-row
    raw labels — labels are surfaced but length-clamped so a long
    in-game name pasted as a label can't act as a tracker).
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

from fastapi import APIRouter, HTTPException, Query, Request

from ..auth import _get_client_ip, _hash_ip
from ..core import database as db
from ..core import saved_routes_db
from ..rate_limiter import check_scoped_rate_limit


logger = logging.getLogger("uvicorn.error")

router = APIRouter(prefix="/public/road-workers", tags=["public-road-workers"])


_MAX_WINDOW_DAYS = 180
_DEFAULT_WINDOW_DAYS = 30
_CACHE_TTL_SECONDS = 120.0
_PUBLIC_LABEL_LEN = 60
_PUBLIC_TOP_LIMIT = 30
_PUBLIC_HEATMAP_CELL = 128

_IP_RATE_MAX = 60
_IP_RATE_WINDOW = 60   # 60 req / minute / IP


_cache_lock = threading.Lock()
_cache: Dict[Tuple, Tuple[float, Any]] = {}


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
        if len(_cache) >= 32:
            for k in sorted(_cache, key=lambda k: _cache[k][0])[:16]:
                _cache.pop(k, None)
        _cache[key] = (time.monotonic(), value)


def _resolve_window(days: int) -> Tuple[datetime, datetime]:
    days = max(1, min(int(days), _MAX_WINDOW_DAYS))
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    return start, end


def _redact_label(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    return value[:_PUBLIC_LABEL_LEN]


def _redact_route(route: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "saves": route["saves"],
        "from": route["from"],
        "to": route["to"],
        "from_label": _redact_label(route.get("from_label")),
        "to_label": _redact_label(route.get("to_label")),
        "total_seconds": route["total_seconds"],
        "walk_blocks": route["walk_blocks"],
        "tl_hops": route["tl_hops"],
        "straight_line_blocks": route["straight_line_blocks"],
        "detour_ratio": route.get("detour_ratio"),
    }


@router.get("")
async def public_road_workers(
    request: Request,
    days: int = Query(_DEFAULT_WINDOW_DAYS, ge=1, le=_MAX_WINDOW_DAYS),
) -> dict:
    """Aggregated, anonymised saved-route data for road workers.

    Query params:
      * ``days`` — rolling window length (default 30, max 180).
    """
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")

    client_ip = _get_client_ip(request)
    ip_hash = _hash_ip(client_ip)
    check_scoped_rate_limit(
        ip_hash, "public-road-workers", _IP_RATE_MAX, _IP_RATE_WINDOW
    )

    start, end = _resolve_window(days)
    cache_key = ("public-road-workers", days)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    top_routes = [
        _redact_route(r)
        for r in saved_routes_db.top_routes(start, end, _PUBLIC_TOP_LIMIT)
    ]
    payload = {
        "from": start.astimezone(timezone.utc).isoformat(),
        "to": end.astimezone(timezone.utc).isoformat(),
        "window_days": days,
        "summary": saved_routes_db.summary(start, end),
        "timeline": saved_routes_db.timeline(start, end, "day"),
        "top_routes": top_routes,
        "top_tl_edges": saved_routes_db.top_tl_edges(start, end, _PUBLIC_TOP_LIMIT),
        "top_start_hops": saved_routes_db.top_start_hops(start, end, _PUBLIC_TOP_LIMIT),
        "endpoint_heatmap": saved_routes_db.endpoint_heatmap(
            start, end, _PUBLIC_HEATMAP_CELL
        ),
    }
    _cache_put(cache_key, payload)
    return payload

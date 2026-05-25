"""Public ingestion endpoint for client-side page-view telemetry.

POSTs from the React app land here. Each request becomes a
``page.view`` row in ``usage_events`` (best-effort). Anonymous
requests are recorded with ``actor_api_key_id=NULL`` and an HMAC-SHA256
digest of the client IP for de-duplication only — raw IPs are never
stored. Per-IP rate limited so a hostile client can't fill the table.

The frontend is expected to normalize dynamic path segments (UUIDs,
numeric ids, slugs) into a small set of route templates before posting;
the server stores exactly what arrives, after a strict regex check, so
the cardinality of the ``metadata->>'path'`` index stays bounded.
"""

from __future__ import annotations

import re
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Request

from ..auth import _get_client_ip, _hash_ip, resolve_key_id
from ..core import usage_events
from ..rate_limiter import check_scoped_rate_limit


router = APIRouter(prefix="/usage", tags=["usage"])


_PATH_RE = re.compile(r"^/[A-Za-z0-9/_\-:.]{0,127}$")
_MAX_PATH_LEN = 128

_PAGE_VIEW_MAX_PER_WINDOW = 120
_PAGE_VIEW_WINDOW_SECONDS = 60

# Batch endpoint: each request can carry up to this many events. With the
# default frontend buffer (max 20, flush every 15s) one user generates at
# most ~4 batches/min, so the per-IP cap of 30 batches/min leaves plenty
# of headroom for shared NATs.
_PAGE_VIEW_BATCH_MAX_EVENTS = 50
_PAGE_VIEW_BATCH_MAX_PER_WINDOW = 30


def _validate_path(raw: object) -> Optional[str]:
    """Return a sanitized path or ``None`` if invalid."""
    if not isinstance(raw, str):
        return None
    p = raw.strip()
    if not p or len(p) > _MAX_PATH_LEN or not _PATH_RE.match(p):
        return None
    return p


@router.post("/page-view", status_code=204)
async def record_page_view(
    request: Request,
    payload: dict,
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
) -> None:
    """Record a single ``page.view`` event. Returns 204 on success.

    The body is a tiny JSON object ``{"path": "/some/route"}``. Any
    other fields are ignored. Bad input returns 400 and is NOT
    recorded.

    Kept for backwards compatibility / sendBeacon fallbacks; the
    frontend now prefers :func:`record_page_views` (batch).
    """
    raw_path = payload.get("path") if isinstance(payload, dict) else None
    path = _validate_path(raw_path)
    if not path:
        raise HTTPException(status_code=400, detail="invalid path")

    client_ip = _get_client_ip(request)
    ip_hash = _hash_ip(client_ip)

    # Per-IP throttle. Use the hash so we don't bucket on raw IPs.
    check_scoped_rate_limit(
        ip_hash,
        "page-view",
        _PAGE_VIEW_MAX_PER_WINDOW,
        _PAGE_VIEW_WINDOW_SECONDS,
    )

    actor_id = None
    if x_api_key:
        try:
            actor_id = resolve_key_id(x_api_key)
        except Exception:
            actor_id = None

    usage_events.record(
        "page.view",
        actor_api_key_id=actor_id,
        category="page",
        metadata={"path": path},
        ip_hash=ip_hash,
    )


@router.post("/page-views", status_code=204)
async def record_page_views(
    request: Request,
    payload: dict,
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
) -> None:
    """Record many ``page.view`` events in one round-trip.

    Body shape::

        {"events": [{"path": "/foo"}, {"path": "/bar"}, ...]}

    Up to 50 events per request. Invalid entries are silently
    dropped; the batch as a whole succeeds as long as at least one
    valid event is present. Empty / malformed bodies return 400.
    """
    raw_events = payload.get("events") if isinstance(payload, dict) else None
    if not isinstance(raw_events, list) or not raw_events:
        raise HTTPException(status_code=400, detail="events must be a non-empty list")
    if len(raw_events) > _PAGE_VIEW_BATCH_MAX_EVENTS:
        raise HTTPException(
            status_code=400,
            detail=f"too many events (max {_PAGE_VIEW_BATCH_MAX_EVENTS})",
        )

    client_ip = _get_client_ip(request)
    ip_hash = _hash_ip(client_ip)

    # One throttle decision per batch — much friendlier than per-event.
    check_scoped_rate_limit(
        ip_hash,
        "page-view-batch",
        _PAGE_VIEW_BATCH_MAX_PER_WINDOW,
        _PAGE_VIEW_WINDOW_SECONDS,
    )

    actor_id = None
    if x_api_key:
        try:
            actor_id = resolve_key_id(x_api_key)
        except Exception:
            actor_id = None

    rows = []
    for raw in raw_events:
        path = _validate_path(raw.get("path") if isinstance(raw, dict) else None)
        if not path:
            continue
        rows.append(
            {
                "event_type": "page.view",
                "category": "page",
                "actor_api_key_id": actor_id,
                "metadata": {"path": path},
                "ip_hash": ip_hash,
            }
        )

    if not rows:
        raise HTTPException(status_code=400, detail="no valid events in batch")

    usage_events.record_batch(rows)

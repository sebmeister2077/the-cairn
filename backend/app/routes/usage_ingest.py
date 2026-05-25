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
    """
    raw_path = payload.get("path") if isinstance(payload, dict) else None
    if not isinstance(raw_path, str):
        raise HTTPException(status_code=400, detail="path must be a string")
    path = raw_path.strip()
    if not path or len(path) > _MAX_PATH_LEN or not _PATH_RE.match(path):
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

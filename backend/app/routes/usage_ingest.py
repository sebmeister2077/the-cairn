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
from ..core import database as db, usage_events
from ..rate_limiter import check_scoped_rate_limit


router = APIRouter(prefix="/usage", tags=["usage"])


_PATH_RE = re.compile(r"^/[A-Za-z0-9/_\-:.]{0,127}$")
_MAX_PATH_LEN = 128

# ``ref`` is the raw entity id (numeric item id / player uid) that the route
# normalizer strips before sending. Kept deliberately narrow so it can't be
# abused to smuggle arbitrary strings into the metadata index. The charset
# covers base64 (VS player uids are base64: ``+`` / ``/`` / ``=``) plus common
# id punctuation.
_REF_RE = re.compile(r"^[A-Za-z0-9:_.+/=-]{1,64}$")
_MAX_REF_LEN = 64
_MAX_LABEL_LEN = 80

_PAGE_VIEW_MAX_PER_WINDOW = 120
_PAGE_VIEW_WINDOW_SECONDS = 60

# The label-upsert endpoint is called at most once per distinct entity per
# browser session, so a modest per-IP cap is plenty.
_PAGE_LABEL_MAX_PER_WINDOW = 60
_PAGE_LABEL_WINDOW_SECONDS = 60

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


def _validate_ref(raw: object) -> Optional[str]:
    """Return a sanitized entity ref or ``None`` if invalid / absent."""
    if not isinstance(raw, str):
        return None
    r = raw.strip()
    if not r or len(r) > _MAX_REF_LEN or not _REF_RE.match(r):
        return None
    return r


def _validate_label(raw: object) -> Optional[str]:
    """Return a trimmed, control-char-free display label or ``None``."""
    if not isinstance(raw, str):
        return None
    # Drop control chars, collapse whitespace, clamp length.
    cleaned = "".join(ch for ch in raw if ch.isprintable()).strip()
    if not cleaned:
        return None
    return cleaned[:_MAX_LABEL_LEN]


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
    ref = _validate_ref(payload.get("ref")) if isinstance(payload, dict) else None

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

    metadata = {"path": path}
    if ref:
        metadata["ref"] = ref
    usage_events.record(
        "page.view",
        actor_api_key_id=actor_id,
        category="page",
        metadata=metadata,
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

        {"events": [{"path": "/foo"}, {"path": "/bar", "ref": "123"}, ...]}

    The optional ``ref`` carries the raw entity id (item id / player uid)
    for routes that opt into per-entity analytics. Up to 50 events per
    request. Invalid entries are silently dropped; the batch as a whole
    succeeds as long as at least one valid event is present. Empty /
    malformed bodies return 400.
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
        is_dict = isinstance(raw, dict)
        path = _validate_path(raw.get("path") if is_dict else None)
        if not path:
            continue
        metadata = {"path": path}
        ref = _validate_ref(raw.get("ref")) if is_dict else None
        if ref:
            metadata["ref"] = ref
        rows.append(
            {
                "event_type": "page.view",
                "category": "page",
                "actor_api_key_id": actor_id,
                "metadata": metadata,
                "ip_hash": ip_hash,
            }
        )

    if not rows:
        raise HTTPException(status_code=400, detail="no valid events in batch")

    usage_events.record_batch(rows)


@router.post("/page-entity-label", status_code=204)
async def record_page_entity_label(
    request: Request,
    payload: dict,
) -> None:
    """Upsert a human-readable label for a viewed entity.

    Body shape::

        {"path": "/market/players/:uid", "ref": "abc123", "label": "SomePlayer"}

    Powers the admin "Items & Players" tab: ``page.view`` events only carry the
    raw ``ref`` (numeric item id / opaque player uid), so the item/player pages
    report the display name here once they know it. Best-effort — this never
    counts a view, it only names one. Bad input returns 400.
    """
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid body")
    path = _validate_path(payload.get("path"))
    ref = _validate_ref(payload.get("ref"))
    label = _validate_label(payload.get("label"))
    if not path or not ref or not label:
        raise HTTPException(status_code=400, detail="invalid path/ref/label")

    client_ip = _get_client_ip(request)
    ip_hash = _hash_ip(client_ip)
    check_scoped_rate_limit(
        ip_hash,
        "page-entity-label",
        _PAGE_LABEL_MAX_PER_WINDOW,
        _PAGE_LABEL_WINDOW_SECONDS,
    )

    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO page_entity_labels (path, ref, label, updated_at)
                            VALUES (%s, %s, %s, now())
                       ON CONFLICT (path, ref)
                       DO UPDATE SET label = EXCLUDED.label,
                                     updated_at = now()""",
                    (path, ref, label),
                )
    except Exception:  # best-effort — naming must never surface an error
        pass


# Fixed allow-list of promo-banner interactions. Kept explicit (rather than a
# free-form string) so a hostile client can't inflate the ``usage_events``
# event_type cardinality. Stored as ``promo.<action>`` under category ``promo``.
_PROMO_ACTIONS = frozenset(
    {"impression", "details_open", "dismiss", "announcement_click", "map_click"}
)
# Matches the ``PROMO.id`` string shipped by the frontend banner.
_PROMO_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")

_PROMO_MAX_PER_WINDOW = 60
_PROMO_WINDOW_SECONDS = 60


@router.post("/promo-event", status_code=204)
async def record_promo_event(
    request: Request,
    payload: dict,
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
) -> None:
    """Record one promo-banner interaction into ``usage_events``.

    Body shape::

        {"promo_id": "tops-chisel-competition-2026-09",
         "action": "dismiss",
         "after_details": true}

    ``action`` must be one of :data:`_PROMO_ACTIONS`; anything else is a 400
    and is not recorded. ``after_details`` is optional and only meaningful for
    the ``dismiss`` action (lets the dashboard split "dismissed outright" from
    "dismissed after opening the details"). Best-effort and rate limited.
    """
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid body")

    action = payload.get("action")
    if not isinstance(action, str) or action not in _PROMO_ACTIONS:
        raise HTTPException(status_code=400, detail="invalid action")

    promo_id = payload.get("promo_id")
    if not isinstance(promo_id, str) or not _PROMO_ID_RE.match(promo_id.strip()):
        raise HTTPException(status_code=400, detail="invalid promo_id")
    promo_id = promo_id.strip()

    client_ip = _get_client_ip(request)
    ip_hash = _hash_ip(client_ip)
    check_scoped_rate_limit(
        ip_hash,
        "promo-event",
        _PROMO_MAX_PER_WINDOW,
        _PROMO_WINDOW_SECONDS,
    )

    actor_id = None
    if x_api_key:
        try:
            actor_id = resolve_key_id(x_api_key)
        except Exception:
            actor_id = None

    metadata: dict = {"promo_id": promo_id}
    if action == "dismiss" and isinstance(payload.get("after_details"), bool):
        metadata["after_details"] = payload["after_details"]

    usage_events.record(
        f"promo.{action}",
        actor_api_key_id=actor_id,
        category="promo",
        metadata=metadata,
        ip_hash=ip_hash,
    )


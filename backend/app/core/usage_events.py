"""Append-only analytics event recorder backing the admin "Usage" dashboard.

This module is intentionally thin and best-effort: callers from hot request
paths should be able to `record(...)` without worrying about latency or
errors. Failures are logged and swallowed.

The table is created by Alembic migration ``0016_usage_events``. Aggregation
queries live in :mod:`app.routes.admin_usage`.

Event-type naming convention: ``<noun>.<verb>`` (lower-case, dot-separated).
Examples::

    contribution.submitted
    contribution.approved
    contribution.rejected
    contribution.reverted
    landmark.added
    translocator.added
    trader.added
    tl_screenshot.uploaded
    backup.redeemed
    admin.<audit_action>   # auto-mirrored from accounts_db.audit_log()

The leading noun is also used as the default *category* if the caller does
not pass one explicitly.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional

from . import database as db


logger = logging.getLogger("app.usage_events")


# Coarse category buckets used by the overview chart's stacking. Anything
# not matched here falls through to ``system``.
_CATEGORY_BY_PREFIX = {
    "contribution": "contribution",
    "landmark": "contribution",
    "translocator": "contribution",
    "trader": "contribution",
    "tl_screenshot": "contribution",
    "admin": "admin",
    "ban": "moderation",
    "flag": "moderation",
    "backup": "download",
    "download": "download",
    "auth": "auth",
    "page": "page",
}


def _infer_category(event_type: str) -> str:
    head = event_type.split(".", 1)[0] if event_type else ""
    return _CATEGORY_BY_PREFIX.get(head, "system")


def record(
    event_type: str,
    *,
    actor_api_key_id: Optional[Any] = None,
    category: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    ip_hash: Optional[str] = None,
) -> None:
    """Insert one row into ``usage_events``. Best-effort: never raises.

    Parameters
    ----------
    event_type:
        Fine-grained dotted label (e.g. ``contribution.submitted``).
    actor_api_key_id:
        Resolved ``api_keys.id`` (UUID or str). Pass ``None`` for system /
        anonymous events. No FK is enforced.
    category:
        Override the inferred category. Use one of: ``contribution`` |
        ``admin`` | ``moderation`` | ``download`` | ``auth`` | ``system``.
    metadata:
        Optional small JSON payload — keep it tiny.
    ip_hash:
        Optional HMAC-SHA256 IP digest (see :func:`app.auth._hash_ip`).
    """
    if not event_type:
        return
    try:
        if not db.is_available():
            return
        cat = category or _infer_category(event_type)
        actor_str = str(actor_api_key_id) if actor_api_key_id else None
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO usage_events
                            (event_type, category, actor_api_key_id, metadata, ip_hash)
                       VALUES (%s, %s, %s, %s, %s)""",
                    (
                        event_type,
                        cat,
                        actor_str,
                        json.dumps(metadata) if metadata else None,
                        ip_hash,
                    ),
                )
    except Exception as exc:  # pragma: no cover — recorder must not block
        logger.warning("usage_events.record(%s) failed: %s", event_type, exc)

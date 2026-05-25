"""Admin "Usage" dashboard — read-only analytics endpoints.

All routes are protected by :func:`app.auth.require_admin` (admin key +
WebAuthn session when enrolled) and live under ``/api/admin/usage``.

Aggregations run against the ``usage_events`` fact table created by Alembic
migration ``0016_usage_events`` and populated by:
  * :mod:`app.core.usage_events` — explicit ``record()`` calls in domain
    insert helpers (contributions, landmarks, translocators, traders,
    TL screenshot requests, backup downloads).
  * :func:`app.core.accounts_db.audit_log` — mirrors every admin action.

The dashboard is **read-only**. No endpoint here mutates state.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import logging
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import psycopg2.extras
from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth import require_admin
from ..core import database as db


logger = logging.getLogger("uvicorn.error")

router = APIRouter(prefix="/admin/usage", tags=["admin-usage"])


# ---------------------------------------------------------------------------
# Constants & helpers
# ---------------------------------------------------------------------------

_MAX_WINDOW_DAYS = 180
_DEFAULT_WINDOW_DAYS = 30
_VALID_GRANULARITIES = {"hour", "day", "week"}
_CACHE_TTL_SECONDS = 60.0
_TOP_N_CAP = 50


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        # Tolerate trailing 'Z'.
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
    """Clamp the request window to ``[max-180d, now]``. Defaults to last 30d."""
    end = _parse_iso(to) or datetime.now(timezone.utc)
    start = _parse_iso(frm) or (end - timedelta(days=_DEFAULT_WINDOW_DAYS))
    if start >= end:
        raise HTTPException(status_code=400, detail="`from` must be before `to`")
    span = end - start
    if span > timedelta(days=_MAX_WINDOW_DAYS):
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


# ---------------------------------------------------------------------------
# Tiny per-process cache. Bounded by simple TTL and a small eviction cap.
# ---------------------------------------------------------------------------

_cache_lock = threading.Lock()
_cache: Dict[Tuple, Tuple[float, Any]] = {}
_CACHE_MAX_ENTRIES = 256


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
            # Drop oldest half. Cheap enough at this size.
            for k in sorted(_cache, key=lambda k: _cache[k][0])[: _CACHE_MAX_ENTRIES // 2]:
                _cache.pop(k, None)
        _cache[key] = (time.monotonic(), value)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _ensure_db() -> None:
    if not db.is_available():
        raise HTTPException(status_code=503, detail="Database not configured")


# ---------------------------------------------------------------------------
# Schemas (returned as plain dicts; no Pydantic models — matches repo style)
# ---------------------------------------------------------------------------


def _empty_window_payload(start: datetime, end: datetime, granularity: str) -> dict:
    return {
        "from": _iso(start),
        "to": _iso(end),
        "granularity": granularity,
        "buckets": [],
    }


# ---------------------------------------------------------------------------
# /summary  — headline counters + deltas vs previous equal-length window.
# ---------------------------------------------------------------------------


@router.get("/summary")
async def usage_summary(
    _: str = Depends(require_admin),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
) -> dict:
    _ensure_db()
    start, end = _resolve_window(frm, to)
    span = end - start
    prev_start = start - span
    prev_end = start
    cache_key = ("summary", _iso(start), _iso(end))
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT category, COUNT(*)::int AS n,
                          COUNT(DISTINCT actor_api_key_id)
                              FILTER (WHERE actor_api_key_id IS NOT NULL)::int
                              AS distinct_actors
                       FROM usage_events
                      WHERE created_at >= %s AND created_at < %s
                   GROUP BY category""",
                (start, end),
            )
            current_rows = list(cur.fetchall())
            cur.execute(
                """SELECT category, COUNT(*)::int AS n
                       FROM usage_events
                      WHERE created_at >= %s AND created_at < %s
                   GROUP BY category""",
                (prev_start, prev_end),
            )
            prev_rows = list(cur.fetchall())
            cur.execute(
                """SELECT COUNT(*)::int AS total,
                          COUNT(DISTINCT actor_api_key_id)
                              FILTER (WHERE actor_api_key_id IS NOT NULL)::int AS actors
                       FROM usage_events
                      WHERE created_at >= %s AND created_at < %s""",
                (start, end),
            )
            cur_totals = dict(cur.fetchone() or {"total": 0, "actors": 0})
            cur.execute(
                """SELECT COUNT(*)::int AS total
                       FROM usage_events
                      WHERE created_at >= %s AND created_at < %s""",
                (prev_start, prev_end),
            )
            prev_totals = dict(cur.fetchone() or {"total": 0})

    by_cat_curr = {r["category"]: r["n"] for r in current_rows}
    by_cat_prev = {r["category"]: r["n"] for r in prev_rows}
    categories = sorted(set(by_cat_curr) | set(by_cat_prev))
    per_category = [
        {
            "category": c,
            "count": int(by_cat_curr.get(c, 0)),
            "previous_count": int(by_cat_prev.get(c, 0)),
        }
        for c in categories
    ]

    payload = {
        "from": _iso(start),
        "to": _iso(end),
        "previous_from": _iso(prev_start),
        "previous_to": _iso(prev_end),
        "totals": {
            "events": int(cur_totals.get("total") or 0),
            "previous_events": int(prev_totals.get("total") or 0),
            "distinct_actors": int(cur_totals.get("actors") or 0),
        },
        "per_category": per_category,
    }
    _cache_put(cache_key, payload)
    return payload


# ---------------------------------------------------------------------------
# /timeline  — generic bucketed counts, optionally filtered.
# ---------------------------------------------------------------------------


@router.get("/timeline")
async def usage_timeline(
    _: str = Depends(require_admin),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    granularity: str = Query("day"),
    group_by: str = Query("category", pattern="^(category|event_type)$"),
    category: Optional[str] = Query(None, max_length=64),
    event_type: Optional[str] = Query(None, max_length=128),
) -> dict:
    _ensure_db()
    start, end = _resolve_window(frm, to)
    gran = _resolve_granularity(granularity)
    cache_key = (
        "timeline", _iso(start), _iso(end), gran, group_by, category or "", event_type or "",
    )
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    where = ["created_at >= %s", "created_at < %s"]
    params: List[Any] = [start, end]
    if category:
        where.append("category = %s")
        params.append(category)
    if event_type:
        where.append("event_type = %s")
        params.append(event_type)
    where_sql = " AND ".join(where)

    group_col = "category" if group_by == "category" else "event_type"
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"""SELECT date_trunc(%s, created_at) AS bucket,
                           {group_col} AS series,
                           COUNT(*)::int AS count
                       FROM usage_events
                      WHERE {where_sql}
                   GROUP BY bucket, series
                   ORDER BY bucket ASC, series ASC""",
                [gran, *params],
            )
            rows = list(cur.fetchall())

    buckets = [
        {
            "bucket": _iso(r["bucket"]),
            "series": r["series"],
            "count": int(r["count"]),
        }
        for r in rows
    ]
    payload = {
        "from": _iso(start),
        "to": _iso(end),
        "granularity": gran,
        "group_by": group_by,
        "buckets": buckets,
    }
    _cache_put(cache_key, payload)
    return payload


# ---------------------------------------------------------------------------
# /heatmap — events by hour-of-day × day-of-week, UTC.
# ---------------------------------------------------------------------------


@router.get("/heatmap")
async def usage_heatmap(
    _: str = Depends(require_admin),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    category: Optional[str] = Query(None, max_length=64),
) -> dict:
    _ensure_db()
    start, end = _resolve_window(frm, to)
    cache_key = ("heatmap", _iso(start), _iso(end), category or "")
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    where = ["created_at >= %s", "created_at < %s"]
    params: List[Any] = [start, end]
    if category:
        where.append("category = %s")
        params.append(category)
    where_sql = " AND ".join(where)

    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT EXTRACT(DOW  FROM created_at AT TIME ZONE 'UTC')::int AS dow,
                           EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int AS hour,
                           COUNT(*)::int AS count
                       FROM usage_events
                      WHERE {where_sql}
                   GROUP BY dow, hour
                   ORDER BY dow, hour""",
                params,
            )
            rows = list(cur.fetchall())

    cells = [
        {"day_of_week": int(d), "hour": int(h), "count": int(c)}
        for (d, h, c) in rows
    ]
    payload = {
        "from": _iso(start),
        "to": _iso(end),
        "cells": cells,
    }
    _cache_put(cache_key, payload)
    return payload


# ---------------------------------------------------------------------------
# /contributions — bucketed counts grouped by sub-type.
# ---------------------------------------------------------------------------


_CONTRIBUTION_EVENT_TYPES = (
    "contribution.submitted",
    "landmark.add",
    "translocator.add",
    "trader.add",
    "tl_screenshot.uploaded",
    "admin.contribution.approve",
    "admin.contribution.reject",
    "admin.contribution.revert",
)


@router.get("/contributions")
async def usage_contributions(
    _: str = Depends(require_admin),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    granularity: str = Query("day"),
) -> dict:
    _ensure_db()
    start, end = _resolve_window(frm, to)
    gran = _resolve_granularity(granularity)
    cache_key = ("contributions", _iso(start), _iso(end), gran)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT date_trunc(%s, created_at) AS bucket,
                          event_type,
                          COUNT(*)::int AS count
                       FROM usage_events
                      WHERE created_at >= %s AND created_at < %s
                        AND (category = 'contribution'
                             OR event_type LIKE 'admin.contribution.%%')
                   GROUP BY bucket, event_type
                   ORDER BY bucket, event_type""",
                (gran, start, end),
            )
            rows = list(cur.fetchall())

    payload = {
        "from": _iso(start),
        "to": _iso(end),
        "granularity": gran,
        "buckets": [
            {
                "bucket": _iso(r["bucket"]),
                "event_type": r["event_type"],
                "count": int(r["count"]),
            }
            for r in rows
        ],
        "known_event_types": list(_CONTRIBUTION_EVENT_TYPES),
    }
    _cache_put(cache_key, payload)
    return payload


# ---------------------------------------------------------------------------
# /admin-activity — admin actions over time.
# ---------------------------------------------------------------------------


@router.get("/admin-activity")
async def usage_admin_activity(
    _: str = Depends(require_admin),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    granularity: str = Query("day"),
    limit_recent: int = Query(50, ge=1, le=200),
) -> dict:
    _ensure_db()
    start, end = _resolve_window(frm, to)
    gran = _resolve_granularity(granularity)
    cache_key = ("admin-activity", _iso(start), _iso(end), gran, int(limit_recent))
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT date_trunc(%s, created_at) AS bucket,
                          event_type AS action,
                          COUNT(*)::int AS count
                       FROM usage_events
                      WHERE category = 'admin'
                        AND created_at >= %s AND created_at < %s
                   GROUP BY bucket, action
                   ORDER BY bucket, action""",
                (gran, start, end),
            )
            buckets = [
                {
                    "bucket": _iso(r["bucket"]),
                    "action": r["action"],
                    "count": int(r["count"]),
                }
                for r in cur.fetchall()
            ]
            cur.execute(
                """SELECT id, created_at, event_type AS action,
                          actor_api_key_id, metadata
                       FROM usage_events
                      WHERE category = 'admin'
                        AND created_at >= %s AND created_at < %s
                   ORDER BY created_at DESC
                      LIMIT %s""",
                (start, end, int(limit_recent)),
            )
            recent = [
                {
                    "id": int(r["id"]),
                    "created_at": _iso(r["created_at"]),
                    "action": r["action"],
                    "actor_api_key_id": str(r["actor_api_key_id"]) if r["actor_api_key_id"] else None,
                    "metadata": r["metadata"],
                }
                for r in cur.fetchall()
            ]

    payload = {
        "from": _iso(start),
        "to": _iso(end),
        "granularity": gran,
        "buckets": buckets,
        "recent": recent,
    }
    _cache_put(cache_key, payload)
    return payload


# ---------------------------------------------------------------------------
# /queue-velocity — median + p90 review latency + current backlog.
# ---------------------------------------------------------------------------


@router.get("/queue-velocity")
async def usage_queue_velocity(
    _: str = Depends(require_admin),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
) -> dict:
    _ensure_db()
    start, end = _resolve_window(frm, to)
    cache_key = ("queue-velocity", _iso(start), _iso(end))
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    out: Dict[str, Any] = {
        "from": _iso(start),
        "to": _iso(end),
        "queues": {},
        "backlog": {},
    }
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Map contributions: created_at -> approved_at.
            cur.execute(
                """SELECT
                        percentile_cont(0.5) WITHIN GROUP (
                            ORDER BY EXTRACT(EPOCH FROM (approved_at - created_at))
                        )::float AS median_seconds,
                        percentile_cont(0.9) WITHIN GROUP (
                            ORDER BY EXTRACT(EPOCH FROM (approved_at - created_at))
                        )::float AS p90_seconds,
                        COUNT(*)::int AS reviewed
                       FROM contributions
                      WHERE approved_at IS NOT NULL
                        AND approved_at >= %s AND approved_at < %s""",
                (start, end),
            )
            out["queues"]["map_contributions"] = dict(cur.fetchone() or {})
            # Landmark edit requests.
            cur.execute(
                """SELECT
                        percentile_cont(0.5) WITHIN GROUP (
                            ORDER BY EXTRACT(EPOCH FROM (reviewed_at - created_at))
                        )::float AS median_seconds,
                        percentile_cont(0.9) WITHIN GROUP (
                            ORDER BY EXTRACT(EPOCH FROM (reviewed_at - created_at))
                        )::float AS p90_seconds,
                        COUNT(*)::int AS reviewed
                       FROM landmark_edit_requests
                      WHERE reviewed_at IS NOT NULL
                        AND reviewed_at >= %s AND reviewed_at < %s""",
                (start, end),
            )
            out["queues"]["landmark_edits"] = dict(cur.fetchone() or {})
            # TL screenshot requests.
            cur.execute(
                """SELECT
                        percentile_cont(0.5) WITHIN GROUP (
                            ORDER BY EXTRACT(EPOCH FROM (decision_at - created_at))
                        )::float AS median_seconds,
                        percentile_cont(0.9) WITHIN GROUP (
                            ORDER BY EXTRACT(EPOCH FROM (decision_at - created_at))
                        )::float AS p90_seconds,
                        COUNT(*)::int AS reviewed
                       FROM translocator_screenshot_requests
                      WHERE decision_at IS NOT NULL
                        AND decision_at >= %s AND decision_at < %s""",
                (start, end),
            )
            out["queues"]["tl_screenshots"] = dict(cur.fetchone() or {})

            # Backlog snapshots (current "pending" counts; cheap COUNT each).
            cur.execute(
                "SELECT COUNT(*)::int AS n FROM contributions WHERE status = 'pending'"
            )
            out["backlog"]["map_contributions"] = int((cur.fetchone() or {}).get("n", 0))
            cur.execute(
                "SELECT COUNT(*)::int AS n FROM landmark_edit_requests WHERE status = 'pending'"
            )
            out["backlog"]["landmark_edits"] = int((cur.fetchone() or {}).get("n", 0))
            cur.execute(
                "SELECT COUNT(*)::int AS n "
                "FROM translocator_screenshot_requests WHERE status = 'pending'"
            )
            out["backlog"]["tl_screenshots"] = int((cur.fetchone() or {}).get("n", 0))

    _cache_put(cache_key, out)
    return out


# ---------------------------------------------------------------------------
# /downloads — backup link redemptions per bucket + recent rows.
# ---------------------------------------------------------------------------


@router.get("/downloads")
async def usage_downloads(
    _: str = Depends(require_admin),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    granularity: str = Query("day"),
    limit_recent: int = Query(50, ge=1, le=200),
) -> dict:
    _ensure_db()
    start, end = _resolve_window(frm, to)
    gran = _resolve_granularity(granularity)
    cache_key = ("downloads", _iso(start), _iso(end), gran, int(limit_recent))
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT date_trunc(%s, redeemed_at) AS bucket,
                          success,
                          COUNT(*)::int AS count
                       FROM backup_download_log
                      WHERE redeemed_at >= %s AND redeemed_at < %s
                   GROUP BY bucket, success
                   ORDER BY bucket""",
                (gran, start, end),
            )
            buckets = [
                {
                    "bucket": _iso(r["bucket"]),
                    "success": bool(r["success"]),
                    "count": int(r["count"]),
                }
                for r in cur.fetchall()
            ]
            cur.execute(
                """SELECT id, link_id, redeemed_at, ip_hash, user_agent,
                          success, failure_reason
                       FROM backup_download_log
                      WHERE redeemed_at >= %s AND redeemed_at < %s
                   ORDER BY redeemed_at DESC
                      LIMIT %s""",
                (start, end, int(limit_recent)),
            )
            recent = []
            for r in cur.fetchall():
                row = dict(r)
                row["redeemed_at"] = _iso(row.get("redeemed_at"))
                # Truncate ip_hash for display — the FE shouldn't need the
                # full digest, and the short prefix is plenty to dedupe.
                if row.get("ip_hash"):
                    row["ip_hash"] = row["ip_hash"][:12]
                recent.append(row)

    payload = {
        "from": _iso(start),
        "to": _iso(end),
        "granularity": gran,
        "buckets": buckets,
        "recent": recent,
    }
    _cache_put(cache_key, payload)
    return payload


# ---------------------------------------------------------------------------
# /moderation — ip bans created/expired and user flags created/resolved.
# ---------------------------------------------------------------------------


@router.get("/moderation")
async def usage_moderation(
    _: str = Depends(require_admin),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    granularity: str = Query("day"),
) -> dict:
    _ensure_db()
    start, end = _resolve_window(frm, to)
    gran = _resolve_granularity(granularity)
    cache_key = ("moderation", _iso(start), _iso(end), gran)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT date_trunc(%s, banned_at) AS bucket,
                          COUNT(*)::int AS count
                       FROM ip_bans
                      WHERE banned_at >= %s AND banned_at < %s
                   GROUP BY bucket
                   ORDER BY bucket""",
                (gran, start, end),
            )
            bans_created = [
                {"bucket": _iso(r["bucket"]), "count": int(r["count"])}
                for r in cur.fetchall()
            ]
            cur.execute(
                """SELECT date_trunc(%s, created_at) AS bucket,
                          COUNT(*)::int AS count
                       FROM user_flags
                      WHERE created_at >= %s AND created_at < %s
                   GROUP BY bucket
                   ORDER BY bucket""",
                (gran, start, end),
            )
            flags_created = [
                {"bucket": _iso(r["bucket"]), "count": int(r["count"])}
                for r in cur.fetchall()
            ]
            cur.execute(
                """SELECT date_trunc(%s, resolved_at) AS bucket,
                          COUNT(*)::int AS count
                       FROM user_flags
                      WHERE resolved_at IS NOT NULL
                        AND resolved_at >= %s AND resolved_at < %s
                   GROUP BY bucket
                   ORDER BY bucket""",
                (gran, start, end),
            )
            flags_resolved = [
                {"bucket": _iso(r["bucket"]), "count": int(r["count"])}
                for r in cur.fetchall()
            ]

    payload = {
        "from": _iso(start),
        "to": _iso(end),
        "granularity": gran,
        "bans_created": bans_created,
        "flags_created": flags_created,
        "flags_resolved": flags_resolved,
    }
    _cache_put(cache_key, payload)
    return payload


# ---------------------------------------------------------------------------
# /api-keys — new keys per bucket + active key counts + top actors.
# ---------------------------------------------------------------------------


@router.get("/api-keys")
async def usage_api_keys(
    _: str = Depends(require_admin),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    granularity: str = Query("day"),
) -> dict:
    _ensure_db()
    start, end = _resolve_window(frm, to)
    gran = _resolve_granularity(granularity)
    cache_key = ("api-keys", _iso(start), _iso(end), gran)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT date_trunc(%s, created_at) AS bucket,
                          COUNT(*)::int AS count
                       FROM api_keys
                      WHERE created_at >= %s AND created_at < %s
                   GROUP BY bucket
                   ORDER BY bucket""",
                (gran, start, end),
            )
            new_keys = [
                {"bucket": _iso(r["bucket"]), "count": int(r["count"])}
                for r in cur.fetchall()
            ]
            cur.execute(
                """SELECT date_trunc(%s, created_at) AS bucket,
                          COUNT(DISTINCT actor_api_key_id)::int AS count
                       FROM usage_events
                      WHERE created_at >= %s AND created_at < %s
                        AND actor_api_key_id IS NOT NULL
                   GROUP BY bucket
                   ORDER BY bucket""",
                (gran, start, end),
            )
            active_keys = [
                {"bucket": _iso(r["bucket"]), "count": int(r["count"])}
                for r in cur.fetchall()
            ]

    payload = {
        "from": _iso(start),
        "to": _iso(end),
        "granularity": gran,
        "new_keys": new_keys,
        "active_keys": active_keys,
    }
    _cache_put(cache_key, payload)
    return payload


# ---------------------------------------------------------------------------
# /top-actors — top N actors in window by event count.
# ---------------------------------------------------------------------------


@router.get("/top-actors")
async def usage_top_actors(
    _: str = Depends(require_admin),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    category: Optional[str] = Query(None, max_length=64),
    limit: int = Query(10, ge=1, le=_TOP_N_CAP),
) -> dict:
    _ensure_db()
    start, end = _resolve_window(frm, to)
    cache_key = ("top-actors", _iso(start), _iso(end), category or "", int(limit))
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    where = [
        "ue.created_at >= %s",
        "ue.created_at < %s",
        "ue.actor_api_key_id IS NOT NULL",
    ]
    params: List[Any] = [start, end]
    if category:
        where.append("ue.category = %s")
        params.append(category)
    where_sql = " AND ".join(where)

    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # LEFT JOIN against users so we can surface a display name when
            # one exists. Falls back to the bare actor_api_key_id (UUID) for
            # legacy / env-var keys with no users row. Never returns the raw
            # api_key string.
            cur.execute(
                f"""SELECT ue.actor_api_key_id AS actor_api_key_id,
                           u.display_name AS display_name,
                           COUNT(*)::int AS count
                       FROM usage_events ue
                       LEFT JOIN users u ON u.api_key_id::text = ue.actor_api_key_id
                      WHERE {where_sql}
                   GROUP BY ue.actor_api_key_id, u.display_name
                   ORDER BY count DESC
                      LIMIT %s""",
                [*params, int(limit)],
            )
            rows = [
                {
                    "actor_api_key_id": str(r["actor_api_key_id"]),
                    "display_name": r["display_name"],
                    "count": int(r["count"]),
                }
                for r in cur.fetchall()
            ]

    payload = {
        "from": _iso(start),
        "to": _iso(end),
        "category": category,
        "actors": rows,
    }
    _cache_put(cache_key, payload)
    return payload


# ---------------------------------------------------------------------------
# /pages — most-visited route templates and per-path timeline.
# ---------------------------------------------------------------------------


@router.get("/pages")
async def usage_pages(
    _: str = Depends(require_admin),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    granularity: str = Query("day"),
    limit: int = Query(20, ge=1, le=_TOP_N_CAP),
    path: Optional[str] = Query(None, max_length=128),
) -> dict:
    """Return top routes by ``page.view`` event count plus a bucketed
    timeline. When ``path`` is given the timeline is filtered to that
    single route; otherwise it stacks the top-5 routes.
    """
    _ensure_db()
    start, end = _resolve_window(frm, to)
    gran = _resolve_granularity(granularity)
    cache_key = ("pages", _iso(start), _iso(end), gran, int(limit), path or "")
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT metadata->>'path' AS path,
                          COUNT(*)::int AS views,
                          COUNT(DISTINCT actor_api_key_id)::int AS distinct_actors,
                          COUNT(DISTINCT ip_hash)::int AS distinct_ips
                       FROM usage_events
                      WHERE event_type = 'page.view'
                        AND created_at >= %s AND created_at < %s
                        AND metadata ? 'path'
                   GROUP BY metadata->>'path'
                   ORDER BY views DESC
                      LIMIT %s""",
                (start, end, int(limit)),
            )
            top_rows = [
                {
                    "path": r["path"],
                    "views": int(r["views"]),
                    "distinct_actors": int(r["distinct_actors"] or 0),
                    "distinct_ips": int(r["distinct_ips"] or 0),
                }
                for r in cur.fetchall()
            ]

            timeline_paths: List[str]
            if path:
                timeline_paths = [path]
            else:
                timeline_paths = [r["path"] for r in top_rows[:5] if r["path"]]

            buckets: List[Dict[str, Any]] = []
            if timeline_paths:
                cur.execute(
                    """SELECT date_trunc(%s, created_at) AS bucket,
                              metadata->>'path' AS path,
                              COUNT(*)::int AS count
                           FROM usage_events
                          WHERE event_type = 'page.view'
                            AND created_at >= %s AND created_at < %s
                            AND metadata->>'path' = ANY(%s)
                       GROUP BY bucket, path
                       ORDER BY bucket, path""",
                    (gran, start, end, timeline_paths),
                )
                buckets = [
                    {
                        "bucket": _iso(r["bucket"]),
                        "path": r["path"],
                        "count": int(r["count"]),
                    }
                    for r in cur.fetchall()
                ]

    payload = {
        "from": _iso(start),
        "to": _iso(end),
        "granularity": gran,
        "selected_path": path,
        "top": top_rows,
        "timeline": buckets,
    }
    _cache_put(cache_key, payload)
    return payload


# ---------------------------------------------------------------------------
# /saved-routes — Route planner "save for road workers" analytics.
# ---------------------------------------------------------------------------


@router.get("/saved-routes")
async def usage_saved_routes(
    _: str = Depends(require_admin),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    granularity: str = Query("day"),
    top_limit: int = Query(20, ge=1, le=100),
    recent_limit: int = Query(50, ge=1, le=500),
    recent_offset: int = Query(0, ge=0),
    heatmap_cell: int = Query(128, ge=16, le=1024),
) -> dict:
    """Bundle of aggregations powering the admin "Saved Routes" tab.

    Returns ``summary``, ``timeline``, ``top_routes``, ``top_tl_edges``,
    ``top_start_hops``, ``endpoint_heatmap``, and ``recent`` in one
    call to minimise round-trips. The public road-worker endpoint reuses
    the same helpers but drops ``recent`` and the actor-bearing fields.
    """
    from ..core import saved_routes_db

    _ensure_db()
    start, end = _resolve_window(frm, to)
    gran = _resolve_granularity(granularity)
    cache_key = (
        "saved_routes",
        _iso(start),
        _iso(end),
        gran,
        top_limit,
        recent_limit,
        recent_offset,
        heatmap_cell,
    )
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    payload = {
        "from": _iso(start),
        "to": _iso(end),
        "granularity": gran,
        "summary": saved_routes_db.summary(start, end),
        "timeline": saved_routes_db.timeline(start, end, gran),
        "top_routes": saved_routes_db.top_routes(start, end, top_limit),
        "top_tl_edges": saved_routes_db.top_tl_edges(start, end, top_limit),
        "top_start_hops": saved_routes_db.top_start_hops(start, end, top_limit),
        "endpoint_heatmap": saved_routes_db.endpoint_heatmap(start, end, heatmap_cell),
        "recent": saved_routes_db.list_recent(
            start, end, limit=recent_limit, offset=recent_offset
        ),
    }
    _cache_put(cache_key, payload)
    return payload



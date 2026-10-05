"""DB helpers for the ``planned_routes`` analytics table.

The frontend route planner records *every completed computation* (both
endpoints set + a result produced) via :func:`insert_or_bump`. The admin
"Route Planner" audit page and the TOPS-map movement overlay consume the
aggregation helpers below.

This mirrors :mod:`app.core.saved_routes_db` (the explicit "save for road
workers" store) but adds route-planner usage dimensions: ``mode``,
endpoint ``source`` (how the coords were set), the non-default ``settings``
diff, and the chosen alternative ``selected_index``.

Soft-dedup contract: a plan by the same identity (api_key_id if signed in,
otherwise ip_hash) of the same ``route_signature`` within the last
``DEDUP_WINDOW_HOURS`` UPDATEs the existing row's ``plan_count`` +
``last_planned_at`` (and refreshes the chosen alternative / sources /
settings) instead of inserting a new one.
"""

from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from . import database as db
from .saved_routes_db import (
    build_tl_hop_sequence,
    compute_route_signature,
    euclidean,
    _parse_edge,
)


logger = logging.getLogger("app.planned_routes")


DEDUP_WINDOW_HOURS = 24

VALID_SOURCES = {"map-click", "landmark", "paste", "favorite", "url"}
VALID_MODES = {"route", "rendezvous"}

# Settings keys we track deviations for (must match the client payload).
SETTING_KEYS = (
    "walk_speed",
    "tl_penalty_seconds",
    "k_neighbors",
    "number_of_routes",
    "elk_friendly_only",
    "rendezvous_objective",
)

# Re-exported so callers don't need to import saved_routes_db directly.
__all__ = [
    "build_tl_hop_sequence",
    "compute_route_signature",
    "euclidean",
    "insert_or_bump",
    "summary",
    "timeline",
    "source_breakdown",
    "settings_breakdown",
    "selected_rank_breakdown",
    "top_routes",
    "top_tl_edges",
    "endpoint_heatmap",
    "route_flows",
]


# ---------------------------------------------------------------------------
# Insert / soft-dedup
# ---------------------------------------------------------------------------


def insert_or_bump(
    *,
    actor_api_key_id: Optional[str],
    ip_hash: Optional[str],
    mode: str,
    from_x: int,
    from_z: int,
    to_x: int,
    to_z: int,
    from_label: Optional[str],
    to_label: Optional[str],
    from_source: Optional[str],
    to_source: Optional[str],
    total_seconds: float,
    walk_blocks: float,
    tl_hops: int,
    walk_speed: Optional[float],
    tl_penalty_seconds: Optional[float],
    k_neighbors: Optional[int],
    number_of_routes: Optional[int],
    elk_friendly_only: Optional[bool],
    settings: Dict[str, Any],
    selected_index: Optional[int],
    num_alternatives: Optional[int],
    tl_hop_sequence: str,
    route_signature: str,
    legs: List[Dict[str, Any]],
    straight_line_blocks: float,
) -> Tuple[str, int, int]:
    """Insert a new row or bump an existing dedup match.

    Returns ``(status, row_id, plan_count)`` where ``status`` is one of
    ``"inserted"`` or ``"merged"``.
    """
    if not db.is_available():
        raise RuntimeError("Database not configured")

    identity = actor_api_key_id or ip_hash
    cutoff = datetime.now(timezone.utc) - timedelta(hours=DEDUP_WINDOW_HOURS)
    legs_json = json.dumps(legs)
    settings_json = json.dumps(settings or {})

    with db.get_conn() as conn:
        with conn.cursor() as cur:
            existing_id: Optional[int] = None
            existing_count: int = 0
            if identity is not None:
                if actor_api_key_id is not None:
                    cur.execute(
                        """SELECT id, plan_count FROM planned_routes
                            WHERE actor_api_key_id = %s
                              AND route_signature = %s
                              AND last_planned_at >= %s
                            ORDER BY last_planned_at DESC
                            LIMIT 1
                            FOR UPDATE""",
                        (actor_api_key_id, route_signature, cutoff),
                    )
                else:
                    cur.execute(
                        """SELECT id, plan_count FROM planned_routes
                            WHERE actor_api_key_id IS NULL
                              AND ip_hash = %s
                              AND route_signature = %s
                              AND last_planned_at >= %s
                            ORDER BY last_planned_at DESC
                            LIMIT 1
                            FOR UPDATE""",
                        (ip_hash, route_signature, cutoff),
                    )
                row = cur.fetchone()
                if row:
                    existing_id = int(row[0])
                    existing_count = int(row[1])

            if existing_id is not None:
                # Bump the counter and refresh the most-recent intent
                # (chosen alternative, endpoint sources, settings diff).
                cur.execute(
                    """UPDATE planned_routes
                          SET plan_count = plan_count + 1,
                              last_planned_at = now(),
                              selected_index = %s,
                              num_alternatives = %s,
                              from_source = %s,
                              to_source = %s,
                              settings = %s
                        WHERE id = %s""",
                    (
                        int(selected_index) if selected_index is not None else None,
                        int(num_alternatives) if num_alternatives is not None else None,
                        from_source,
                        to_source,
                        settings_json,
                        existing_id,
                    ),
                )
                return ("merged", existing_id, existing_count + 1)

            cur.execute(
                """INSERT INTO planned_routes
                        (actor_api_key_id, ip_hash, mode,
                         from_x, from_z, to_x, to_z,
                         from_label, to_label, from_source, to_source,
                         total_seconds, walk_blocks, tl_hops,
                         walk_speed, tl_penalty_seconds, k_neighbors,
                         number_of_routes, elk_friendly_only, settings,
                         selected_index, num_alternatives,
                         tl_hop_sequence, route_signature,
                         legs, straight_line_blocks)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                           %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                           %s, %s, %s, %s)
                   RETURNING id""",
                (
                    actor_api_key_id,
                    ip_hash,
                    mode,
                    int(from_x),
                    int(from_z),
                    int(to_x),
                    int(to_z),
                    from_label,
                    to_label,
                    from_source,
                    to_source,
                    float(total_seconds),
                    float(walk_blocks),
                    int(tl_hops),
                    float(walk_speed) if walk_speed is not None else None,
                    float(tl_penalty_seconds) if tl_penalty_seconds is not None else None,
                    int(k_neighbors) if k_neighbors is not None else None,
                    int(number_of_routes) if number_of_routes is not None else None,
                    bool(elk_friendly_only) if elk_friendly_only is not None else None,
                    settings_json,
                    int(selected_index) if selected_index is not None else None,
                    int(num_alternatives) if num_alternatives is not None else None,
                    tl_hop_sequence,
                    route_signature,
                    legs_json,
                    float(straight_line_blocks),
                ),
            )
            new_id = int(cur.fetchone()[0])
            return ("inserted", new_id, 1)


# ---------------------------------------------------------------------------
# Aggregations consumed by admin + map endpoints
# ---------------------------------------------------------------------------


def _window_clause() -> str:
    return "last_planned_at >= %s AND last_planned_at < %s"


def summary(start: datetime, end: datetime) -> Dict[str, Any]:
    """Headline counters for the window."""
    if not db.is_available():
        return {
            "total_plans": 0,
            "distinct_routes": 0,
            "distinct_identities": 0,
            "route_plans": 0,
            "rendezvous_plans": 0,
            "avg_detour_ratio": None,
        }
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT
                        COALESCE(SUM(plan_count), 0)::bigint AS total_plans,
                        COUNT(DISTINCT route_signature)::bigint AS distinct_routes,
                        COUNT(DISTINCT COALESCE(actor_api_key_id, ip_hash))::bigint
                            AS distinct_identities,
                        COALESCE(SUM(plan_count) FILTER (WHERE mode = 'route'), 0)::bigint
                            AS route_plans,
                        COALESCE(SUM(plan_count) FILTER (WHERE mode = 'rendezvous'), 0)::bigint
                            AS rendezvous_plans,
                        AVG(CASE WHEN straight_line_blocks > 0
                                 THEN walk_blocks / straight_line_blocks
                                 ELSE NULL END)::float AS avg_detour_ratio
                      FROM planned_routes
                     WHERE {_window_clause()}""",
                (start, end),
            )
            row = cur.fetchone() or (0, 0, 0, 0, 0, None)
    return {
        "total_plans": int(row[0] or 0),
        "distinct_routes": int(row[1] or 0),
        "distinct_identities": int(row[2] or 0),
        "route_plans": int(row[3] or 0),
        "rendezvous_plans": int(row[4] or 0),
        "avg_detour_ratio": float(row[5]) if row[5] is not None else None,
    }


def timeline(
    start: datetime, end: datetime, granularity: str
) -> List[Dict[str, Any]]:
    trunc = {"hour": "hour", "day": "day", "week": "week"}.get(granularity, "day")
    if not db.is_available():
        return []
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT date_trunc(%s, last_planned_at) AS bucket,
                          COALESCE(SUM(plan_count), 0)::bigint AS plans,
                          COALESCE(SUM(plan_count) FILTER (WHERE mode = 'rendezvous'),
                                   0)::bigint AS rendezvous_plans
                     FROM planned_routes
                    WHERE {_window_clause()}
                 GROUP BY bucket
                 ORDER BY bucket""",
                (trunc, start, end),
            )
            rows = cur.fetchall()
    return [
        {
            "bucket": r[0].astimezone(timezone.utc).isoformat(),
            "plans": int(r[1]),
            "rendezvous_plans": int(r[2]),
        }
        for r in rows
    ]


def source_breakdown(start: datetime, end: datetime) -> Dict[str, List[Dict[str, Any]]]:
    """Counts of how endpoints were set, separately for ``from`` and ``to``."""
    if not db.is_available():
        return {"from": [], "to": []}

    def _query(column: str) -> List[Dict[str, Any]]:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""SELECT COALESCE({column}, 'unknown') AS source,
                              COALESCE(SUM(plan_count), 0)::bigint AS plans
                         FROM planned_routes
                        WHERE {_window_clause()}
                     GROUP BY source
                     ORDER BY plans DESC""",
                    (start, end),
                )
                return [
                    {"source": r[0], "plans": int(r[1])} for r in cur.fetchall()
                ]

    return {"from": _query("from_source"), "to": _query("to_source")}


def settings_breakdown(start: datetime, end: datetime) -> Dict[str, Any]:
    """How often each setting deviated from its default, with value spreads.

    ``settings`` stores ONLY the non-default settings, so a key's presence
    means the user changed it. We count rows (weighted by plan_count) that
    contain each key and tally the distinct values chosen.
    """
    if not db.is_available():
        return {"total_plans": 0, "settings": []}
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT COALESCE(SUM(plan_count), 0)::bigint
                      FROM planned_routes
                     WHERE {_window_clause()}""",
                (start, end),
            )
            total = int((cur.fetchone() or (0,))[0] or 0)

            out: List[Dict[str, Any]] = []
            for key in SETTING_KEYS:
                cur.execute(
                    f"""SELECT settings->>%s AS val,
                              COALESCE(SUM(plan_count), 0)::bigint AS plans
                         FROM planned_routes
                        WHERE {_window_clause()}
                          AND settings ? %s
                     GROUP BY val
                     ORDER BY plans DESC""",
                    (key, start, end, key),
                )
                value_rows = cur.fetchall()
                changed = sum(int(r[1]) for r in value_rows)
                if changed == 0:
                    continue
                out.append(
                    {
                        "key": key,
                        "changed_plans": changed,
                        "values": [
                            {"value": r[0], "plans": int(r[1])} for r in value_rows
                        ],
                    }
                )
    out.sort(key=lambda s: s["changed_plans"], reverse=True)
    return {"total_plans": total, "settings": out}


def selected_rank_breakdown(start: datetime, end: datetime) -> Dict[str, Any]:
    """Distribution of which alternative route users chose (0 = best)."""
    if not db.is_available():
        return {"total_plans": 0, "overrode_best": 0, "ranks": []}
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT COALESCE(selected_index, 0) AS rank,
                          COALESCE(SUM(plan_count), 0)::bigint AS plans
                     FROM planned_routes
                    WHERE {_window_clause()}
                 GROUP BY rank
                 ORDER BY rank""",
                (start, end),
            )
            rows = cur.fetchall()
    ranks = [{"rank": int(r[0]), "plans": int(r[1])} for r in rows]
    total = sum(r["plans"] for r in ranks)
    overrode_best = sum(r["plans"] for r in ranks if r["rank"] != 0)
    return {"total_plans": total, "overrode_best": overrode_best, "ranks": ranks}


def top_routes(start: datetime, end: datetime, limit: int) -> List[Dict[str, Any]]:
    if not db.is_available():
        return []
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""WITH agg AS (
                        SELECT route_signature,
                               SUM(plan_count)::bigint AS plans,
                               MAX(last_planned_at) AS last_planned
                          FROM planned_routes
                         WHERE {_window_clause()}
                      GROUP BY route_signature
                    )
                    SELECT s.route_signature,
                           agg.plans,
                           agg.last_planned,
                           s.from_x, s.from_z, s.to_x, s.to_z,
                           s.from_label, s.to_label,
                           s.total_seconds, s.walk_blocks, s.tl_hops,
                           s.straight_line_blocks, s.mode
                      FROM agg
                      JOIN LATERAL (
                          SELECT *
                            FROM planned_routes pr
                           WHERE pr.route_signature = agg.route_signature
                           ORDER BY pr.last_planned_at DESC
                           LIMIT 1
                      ) s ON true
                  ORDER BY agg.plans DESC, agg.last_planned DESC
                     LIMIT %s""",
                (start, end, int(limit)),
            )
            rows = cur.fetchall()
    out: List[Dict[str, Any]] = []
    for r in rows:
        straight = float(r[12] or 0)
        walk = float(r[10] or 0)
        out.append(
            {
                "route_signature": r[0],
                "plans": int(r[1]),
                "last_planned_at": r[2].astimezone(timezone.utc).isoformat(),
                "from": {"x": int(r[3]), "z": int(r[4])},
                "to": {"x": int(r[5]), "z": int(r[6])},
                "from_label": r[7],
                "to_label": r[8],
                "total_seconds": float(r[9] or 0),
                "walk_blocks": walk,
                "tl_hops": int(r[11] or 0),
                "straight_line_blocks": straight,
                "detour_ratio": (walk / straight) if straight > 0 else None,
                "mode": r[13],
            }
        )
    return out


def top_tl_edges(start: datetime, end: datetime, limit: int) -> List[Dict[str, Any]]:
    if not db.is_available():
        return []
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT edge, SUM(plan_count)::bigint AS plans
                      FROM (
                          SELECT plan_count,
                                 unnest(string_to_array(tl_hop_sequence, '|')) AS edge
                            FROM planned_routes
                           WHERE {_window_clause()}
                             AND tl_hop_sequence <> ''
                      ) t
                     WHERE edge <> ''
                  GROUP BY edge
                  ORDER BY plans DESC
                     LIMIT %s""",
                (start, end, int(limit)),
            )
            rows = cur.fetchall()
    out: List[Dict[str, Any]] = []
    for edge, plans in rows:
        coords = _parse_edge(edge)
        if coords is None:
            continue
        fx, fz, tx, tz = coords
        out.append(
            {
                "edge": edge,
                "from": {"x": fx, "z": fz},
                "to": {"x": tx, "z": tz},
                "plans": int(plans),
            }
        )
    return out


def endpoint_heatmap(
    start: datetime, end: datetime, cell: int = 128
) -> Dict[str, Any]:
    """Bucketed counts for From and To endpoints."""
    if not db.is_available():
        return {"cell_blocks": max(16, int(cell)), "from": [], "to": []}
    cell = max(16, int(cell))
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT (from_x / %s) * %s AS cx,
                          (from_z / %s) * %s AS cz,
                          SUM(plan_count)::bigint AS plans
                     FROM planned_routes
                    WHERE {_window_clause()}
                 GROUP BY cx, cz""",
                (cell, cell, cell, cell, start, end),
            )
            from_rows = cur.fetchall()
            cur.execute(
                f"""SELECT (to_x / %s) * %s AS cx,
                          (to_z / %s) * %s AS cz,
                          SUM(plan_count)::bigint AS plans
                     FROM planned_routes
                    WHERE {_window_clause()}
                 GROUP BY cx, cz""",
                (cell, cell, cell, cell, start, end),
            )
            to_rows = cur.fetchall()
    return {
        "cell_blocks": cell,
        "from": [
            {"x": int(r[0]), "z": int(r[1]), "plans": int(r[2])} for r in from_rows
        ],
        "to": [
            {"x": int(r[0]), "z": int(r[1]), "plans": int(r[2])} for r in to_rows
        ],
    }


def route_flows(start: datetime, end: datetime, limit: int = 400) -> List[Dict[str, Any]]:
    """Aggregated directed segments weighted by plan_count, for the map overlay.

    Each top route's ordered leg geometry is flattened into point-to-point
    segments; identical segments across routes are summed so a thicker/
    brighter line means "more people traverse this".
    """
    if not db.is_available():
        return []
    limit = max(1, min(int(limit), 2000))
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""WITH agg AS (
                        SELECT route_signature,
                               SUM(plan_count)::bigint AS plans,
                               MAX(last_planned_at) AS last_planned
                          FROM planned_routes
                         WHERE {_window_clause()}
                      GROUP BY route_signature
                    )
                    SELECT s.legs, agg.plans
                      FROM agg
                      JOIN LATERAL (
                          SELECT legs
                            FROM planned_routes pr
                           WHERE pr.route_signature = agg.route_signature
                           ORDER BY pr.last_planned_at DESC
                           LIMIT 1
                      ) s ON true
                  ORDER BY agg.plans DESC
                     LIMIT %s""",
                (start, end, limit),
            )
            rows = cur.fetchall()

    # key -> {from, to, kind, plans}
    segments: Dict[Tuple[int, int, int, int, str], Dict[str, Any]] = {}
    for legs, plans in rows:
        plans = int(plans or 0)
        if not isinstance(legs, list):
            continue
        for leg in legs:
            if not isinstance(leg, dict):
                continue
            kind = leg.get("kind")
            if kind not in ("walk", "tl"):
                continue
            fr = leg.get("from") or {}
            to = leg.get("to") or {}
            try:
                fx = int(round(float(fr.get("x"))))
                fz = int(round(float(fr.get("z"))))
                tx = int(round(float(to.get("x"))))
                tz = int(round(float(to.get("z"))))
            except (TypeError, ValueError):
                continue
            key = (fx, fz, tx, tz, kind)
            entry = segments.get(key)
            if entry is None:
                segments[key] = {
                    "from": {"x": fx, "z": fz},
                    "to": {"x": tx, "z": tz},
                    "kind": kind,
                    "plans": plans,
                }
            else:
                entry["plans"] += plans

    out = list(segments.values())
    out.sort(key=lambda s: s["plans"], reverse=True)
    return out

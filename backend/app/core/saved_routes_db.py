"""DB helpers for the ``saved_routes`` analytics table.

The frontend route planner ("Save this route for road workers" button)
hits :func:`insert_or_bump`. The admin Usage dashboard and the public
"road workers" page consume the aggregation helpers below.

Soft-dedup contract: a save by the same identity (api_key_id if signed
in, otherwise ip_hash) of the same ``route_signature`` within the last
``DEDUP_WINDOW_HOURS`` will UPDATE the existing row's ``save_count`` and
``last_saved_at`` instead of inserting a new one. Older matches always
insert a fresh row so we can see "this route was popular again 6 months
later" rather than silently coalescing across years.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from . import database as db


logger = logging.getLogger("app.saved_routes")


DEDUP_WINDOW_HOURS = 24
SIGNATURE_QUANTIZE_BLOCKS = 32


# ---------------------------------------------------------------------------
# Signature helpers
# ---------------------------------------------------------------------------


def _quantize(value: int) -> int:
    return (int(value) // SIGNATURE_QUANTIZE_BLOCKS) * SIGNATURE_QUANTIZE_BLOCKS


def build_tl_hop_sequence(legs: List[Dict[str, Any]]) -> str:
    """Build the canonical ``"x1,z1>x2,z2|..."`` string from the leg list.

    Walk legs are ignored — only TL hops carry meaningful "the road
    workers should look at this edge" information.
    """
    parts: List[str] = []
    for leg in legs:
        if not isinstance(leg, dict):
            continue
        if leg.get("kind") != "tl":
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
        parts.append(f"{fx},{fz}>{tx},{tz}")
    return "|".join(parts)


def compute_route_signature(
    from_x: int,
    from_z: int,
    to_x: int,
    to_z: int,
    tl_hop_sequence: str,
) -> str:
    payload = (
        f"{_quantize(from_x)},{_quantize(from_z)}|"
        f"{_quantize(to_x)},{_quantize(to_z)}|"
        f"{tl_hop_sequence}"
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Insert / soft-dedup
# ---------------------------------------------------------------------------


def insert_or_bump(
    *,
    actor_api_key_id: Optional[str],
    ip_hash: Optional[str],
    from_x: int,
    from_z: int,
    to_x: int,
    to_z: int,
    from_label: Optional[str],
    to_label: Optional[str],
    total_seconds: float,
    walk_blocks: float,
    tl_hops: int,
    walk_speed: Optional[float],
    tl_penalty_seconds: Optional[float],
    k_neighbors: Optional[int],
    tl_hop_sequence: str,
    route_signature: str,
    legs: List[Dict[str, Any]],
    straight_line_blocks: float,
) -> Tuple[str, int, int]:
    """Insert a new row or bump an existing dedup match.

    Returns ``(status, row_id, save_count)`` where ``status`` is one of
    ``"inserted"`` or ``"merged"``.
    """
    if not db.is_available():
        raise RuntimeError("Database not configured")

    identity = actor_api_key_id or ip_hash
    cutoff = datetime.now(timezone.utc) - timedelta(hours=DEDUP_WINDOW_HOURS)
    legs_json = json.dumps(legs)

    with db.get_conn() as conn:
        with conn.cursor() as cur:
            existing_id: Optional[int] = None
            existing_count: int = 0
            if identity is not None:
                if actor_api_key_id is not None:
                    cur.execute(
                        """SELECT id, save_count FROM saved_routes
                            WHERE actor_api_key_id = %s
                              AND route_signature = %s
                              AND last_saved_at >= %s
                            ORDER BY last_saved_at DESC
                            LIMIT 1
                            FOR UPDATE""",
                        (actor_api_key_id, route_signature, cutoff),
                    )
                else:
                    cur.execute(
                        """SELECT id, save_count FROM saved_routes
                            WHERE actor_api_key_id IS NULL
                              AND ip_hash = %s
                              AND route_signature = %s
                              AND last_saved_at >= %s
                            ORDER BY last_saved_at DESC
                            LIMIT 1
                            FOR UPDATE""",
                        (ip_hash, route_signature, cutoff),
                    )
                row = cur.fetchone()
                if row:
                    existing_id = int(row[0])
                    existing_count = int(row[1])

            if existing_id is not None:
                cur.execute(
                    """UPDATE saved_routes
                          SET save_count = save_count + 1,
                              last_saved_at = now()
                        WHERE id = %s""",
                    (existing_id,),
                )
                return ("merged", existing_id, existing_count + 1)

            cur.execute(
                """INSERT INTO saved_routes
                        (actor_api_key_id, ip_hash,
                         from_x, from_z, to_x, to_z,
                         from_label, to_label,
                         total_seconds, walk_blocks, tl_hops,
                         walk_speed, tl_penalty_seconds, k_neighbors,
                         tl_hop_sequence, route_signature,
                         legs, straight_line_blocks)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s,
                           %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   RETURNING id""",
                (
                    actor_api_key_id,
                    ip_hash,
                    int(from_x),
                    int(from_z),
                    int(to_x),
                    int(to_z),
                    from_label,
                    to_label,
                    float(total_seconds),
                    float(walk_blocks),
                    int(tl_hops),
                    float(walk_speed) if walk_speed is not None else None,
                    float(tl_penalty_seconds) if tl_penalty_seconds is not None else None,
                    int(k_neighbors) if k_neighbors is not None else None,
                    tl_hop_sequence,
                    route_signature,
                    legs_json,
                    float(straight_line_blocks),
                ),
            )
            new_id = int(cur.fetchone()[0])
            return ("inserted", new_id, 1)


# ---------------------------------------------------------------------------
# Aggregations consumed by admin + public endpoints
# ---------------------------------------------------------------------------


def _window_clause() -> str:
    return "last_saved_at >= %s AND last_saved_at < %s"


def summary(start: datetime, end: datetime) -> Dict[str, Any]:
    """Headline counters for the window."""
    if not db.is_available():
        return {"total_saves": 0, "distinct_routes": 0, "distinct_identities": 0, "avg_detour_ratio": None}
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT
                        COALESCE(SUM(save_count), 0)::bigint AS total_saves,
                        COUNT(DISTINCT route_signature)::bigint AS distinct_routes,
                        COUNT(DISTINCT COALESCE(actor_api_key_id, ip_hash))::bigint AS distinct_identities,
                        AVG(CASE WHEN straight_line_blocks > 0
                                 THEN walk_blocks / straight_line_blocks
                                 ELSE NULL END)::float AS avg_detour_ratio
                      FROM saved_routes
                     WHERE {_window_clause()}""",
                (start, end),
            )
            row = cur.fetchone() or (0, 0, 0, None)
    return {
        "total_saves": int(row[0] or 0),
        "distinct_routes": int(row[1] or 0),
        "distinct_identities": int(row[2] or 0),
        "avg_detour_ratio": float(row[3]) if row[3] is not None else None,
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
                f"""SELECT date_trunc(%s, last_saved_at) AS bucket,
                          COALESCE(SUM(save_count), 0)::bigint AS saves
                     FROM saved_routes
                    WHERE {_window_clause()}
                 GROUP BY bucket
                 ORDER BY bucket""",
                (trunc, start, end),
            )
            rows = cur.fetchall()
    return [
        {"bucket": r[0].astimezone(timezone.utc).isoformat(), "saves": int(r[1])}
        for r in rows
    ]


def top_routes(start: datetime, end: datetime, limit: int) -> List[Dict[str, Any]]:
    if not db.is_available():
        return []
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            # Pick a representative row per signature (most-recent labels +
            # totals) and surface the summed save_count.
            cur.execute(
                f"""WITH agg AS (
                        SELECT route_signature,
                               SUM(save_count)::bigint AS saves,
                               MAX(last_saved_at) AS last_saved
                          FROM saved_routes
                         WHERE {_window_clause()}
                      GROUP BY route_signature
                    )
                    SELECT s.route_signature,
                           agg.saves,
                           agg.last_saved,
                           s.from_x, s.from_z, s.to_x, s.to_z,
                           s.from_label, s.to_label,
                           s.total_seconds, s.walk_blocks, s.tl_hops,
                           s.straight_line_blocks
                      FROM agg
                      JOIN LATERAL (
                          SELECT *
                            FROM saved_routes sr
                           WHERE sr.route_signature = agg.route_signature
                           ORDER BY sr.last_saved_at DESC
                           LIMIT 1
                      ) s ON true
                  ORDER BY agg.saves DESC, agg.last_saved DESC
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
                "saves": int(r[1]),
                "last_saved_at": r[2].astimezone(timezone.utc).isoformat(),
                "from": {"x": int(r[3]), "z": int(r[4])},
                "to": {"x": int(r[5]), "z": int(r[6])},
                "from_label": r[7],
                "to_label": r[8],
                "total_seconds": float(r[9] or 0),
                "walk_blocks": walk,
                "tl_hops": int(r[11] or 0),
                "straight_line_blocks": straight,
                "detour_ratio": (walk / straight) if straight > 0 else None,
            }
        )
    return out


def top_tl_edges(start: datetime, end: datetime, limit: int) -> List[Dict[str, Any]]:
    if not db.is_available():
        return []
    # Split tl_hop_sequence on '|' to get one edge per row, then aggregate.
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT edge, SUM(save_count)::bigint AS saves
                      FROM (
                          SELECT save_count,
                                 unnest(string_to_array(tl_hop_sequence, '|')) AS edge
                            FROM saved_routes
                           WHERE {_window_clause()}
                             AND tl_hop_sequence <> ''
                      ) t
                     WHERE edge <> ''
                  GROUP BY edge
                  ORDER BY saves DESC
                     LIMIT %s""",
                (start, end, int(limit)),
            )
            rows = cur.fetchall()
    out: List[Dict[str, Any]] = []
    for edge, saves in rows:
        coords = _parse_edge(edge)
        if coords is None:
            continue
        fx, fz, tx, tz = coords
        out.append(
            {
                "edge": edge,
                "from": {"x": fx, "z": fz},
                "to": {"x": tx, "z": tz},
                "saves": int(saves),
            }
        )
    return out


def top_start_hops(
    start: datetime, end: datetime, limit: int
) -> List[Dict[str, Any]]:
    if not db.is_available():
        return []
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT split_part(tl_hop_sequence, '|', 1) AS first_edge,
                          SUM(save_count)::bigint AS saves
                     FROM saved_routes
                    WHERE {_window_clause()}
                      AND tl_hop_sequence <> ''
                 GROUP BY first_edge
                 ORDER BY saves DESC
                    LIMIT %s""",
                (start, end, int(limit)),
            )
            rows = cur.fetchall()
    out: List[Dict[str, Any]] = []
    for edge, saves in rows:
        coords = _parse_edge(edge)
        if coords is None:
            continue
        fx, fz, tx, tz = coords
        out.append(
            {
                "edge": edge,
                "from": {"x": fx, "z": fz},
                "to": {"x": tx, "z": tz},
                "saves": int(saves),
            }
        )
    return out


def endpoint_heatmap(
    start: datetime, end: datetime, cell: int = 128
) -> Dict[str, List[Dict[str, Any]]]:
    """Bucketed counts for From and To endpoints."""
    if not db.is_available():
        return {"from": [], "to": []}
    cell = max(16, int(cell))
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT (from_x / %s) * %s AS cx,
                          (from_z / %s) * %s AS cz,
                          SUM(save_count)::bigint AS saves
                     FROM saved_routes
                    WHERE {_window_clause()}
                 GROUP BY cx, cz""",
                (cell, cell, cell, cell, start, end),
            )
            from_rows = cur.fetchall()
            cur.execute(
                f"""SELECT (to_x / %s) * %s AS cx,
                          (to_z / %s) * %s AS cz,
                          SUM(save_count)::bigint AS saves
                     FROM saved_routes
                    WHERE {_window_clause()}
                 GROUP BY cx, cz""",
                (cell, cell, cell, cell, start, end),
            )
            to_rows = cur.fetchall()
    return {
        "cell_blocks": cell,
        "from": [
            {"x": int(r[0]), "z": int(r[1]), "saves": int(r[2])} for r in from_rows
        ],
        "to": [
            {"x": int(r[0]), "z": int(r[1]), "saves": int(r[2])} for r in to_rows
        ],
    }


def list_recent(
    start: datetime,
    end: datetime,
    *,
    limit: int = 50,
    offset: int = 0,
) -> List[Dict[str, Any]]:
    if not db.is_available():
        return []
    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT id, created_at, last_saved_at, save_count,
                          actor_api_key_id, ip_hash,
                          from_x, from_z, to_x, to_z,
                          from_label, to_label,
                          total_seconds, walk_blocks, tl_hops,
                          straight_line_blocks
                     FROM saved_routes
                    WHERE {_window_clause()}
                 ORDER BY last_saved_at DESC
                    LIMIT %s OFFSET %s""",
                (start, end, limit, offset),
            )
            rows = cur.fetchall()
    out: List[Dict[str, Any]] = []
    for r in rows:
        straight = float(r[15] or 0)
        walk = float(r[13] or 0)
        out.append(
            {
                "id": int(r[0]),
                "created_at": r[1].astimezone(timezone.utc).isoformat(),
                "last_saved_at": r[2].astimezone(timezone.utc).isoformat(),
                "save_count": int(r[3]),
                "actor_api_key_id": r[4],
                "ip_hash_short": (r[5][:12] + "…") if r[5] else None,
                "from": {"x": int(r[6]), "z": int(r[7])},
                "to": {"x": int(r[8]), "z": int(r[9])},
                "from_label": r[10],
                "to_label": r[11],
                "total_seconds": float(r[12] or 0),
                "walk_blocks": walk,
                "tl_hops": int(r[14] or 0),
                "straight_line_blocks": straight,
                "detour_ratio": (walk / straight) if straight > 0 else None,
            }
        )
    return out


def _parse_edge(edge: str) -> Optional[Tuple[int, int, int, int]]:
    """Parse ``"fx,fz>tx,tz"``."""
    try:
        left, right = edge.split(">", 1)
        fx_s, fz_s = left.split(",", 1)
        tx_s, tz_s = right.split(",", 1)
        return (int(fx_s), int(fz_s), int(tx_s), int(tz_s))
    except (ValueError, AttributeError):
        return None


def euclidean(from_x: float, from_z: float, to_x: float, to_z: float) -> float:
    dx = float(to_x) - float(from_x)
    dz = float(to_z) - float(from_z)
    return math.hypot(dx, dz)

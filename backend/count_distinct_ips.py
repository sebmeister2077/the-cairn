"""Count how many distinct IP addresses (by their HMAC hash) exist.

The backend never stores raw client IPs — every IP is passed through
``app.auth._hash_ip`` (HMAC-SHA256) and only the digest is persisted in an
``ip_hash`` column. Several tables carry such a column (``usage_events``,
``saved_routes``, ``program_downloads`` …). This tool answers "how many
*different* IPs have we actually seen?" by counting distinct ``ip_hash``
values — per table and as a single de-duplicated total across all of them.

Because the same visitor's hash is identical everywhere, the global union
count is the real number of distinct IPs; summing per-table counts would
double-count anyone who appears in more than one table.

Which database?
    This script reads the same env vars the API uses (``app.config``). Pick
    the environment with ``APP_ENV`` *before* running so it loads the right
    ``.env.<APP_ENV>`` file. For production:

        # PowerShell
        $env:APP_ENV = 'prod'; python backend/count_distinct_ips.py

        # bash
        APP_ENV=prod python backend/count_distinct_ips.py

Usage:
    python count_distinct_ips.py                 # all tables + global total
    python count_distinct_ips.py --from 2026-09-01 --to 2026-10-01
    python count_distinct_ips.py --json          # machine-readable output

The optional ``--from`` / ``--to`` window is applied only to tables that
also have a ``created_at`` column; tables without one are always counted in
full (and flagged as such).

Short-lived ("throwaway") IPs
    The tool also reports how many IPs look like one-off visitors: their
    entire history in ``usage_events`` spans less than ``--short-usage-hours``
    (default 12h, i.e. ``last_event - first_event < 12h``) **and** they have
    gone quiet for at least ``--settle-weeks`` (default 3 weeks). The settle
    window deliberately ignores recent IPs — a visitor seen in the last few
    weeks might still come back, which would make their span grow — so only
    IPs that have had ample time to return are judged. For that same set it
    also reports how many accounts (``api_keys`` bound to those IPs) were
    created.

Read-only: issues nothing but ``SELECT`` statements.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple

# Ensure ``backend/`` is on sys.path so ``app.*`` imports resolve from any cwd.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import psycopg2.extras  # noqa: E402

from app.core import database as db  # noqa: E402  (after path tweak)


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    """Parse an ISO-8601 date/datetime; assume UTC when tz-naive."""
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        # Allow a bare date like 2026-09-01.
        dt = datetime.strptime(text, "%Y-%m-%d")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _discover_ip_hash_tables(cur) -> List[Tuple[str, bool]]:
    """Return ``(table_name, has_created_at)`` for every table with an
    ``ip_hash`` column in the ``public`` schema."""
    cur.execute(
        """
        SELECT c.table_name,
               EXISTS (
                   SELECT 1
                     FROM information_schema.columns cc
                    WHERE cc.table_schema = 'public'
                      AND cc.table_name = c.table_name
                      AND cc.column_name = 'created_at'
               ) AS has_created_at
          FROM information_schema.columns c
         WHERE c.table_schema = 'public'
           AND c.column_name = 'ip_hash'
         ORDER BY c.table_name
        """
    )
    return [(r[0], bool(r[1])) for r in cur.fetchall()]


def _window_clause(
    has_created_at: bool,
    start: Optional[datetime],
    end: Optional[datetime],
) -> Tuple[str, list]:
    """Build an optional ``created_at`` window predicate + params."""
    if not has_created_at or (start is None and end is None):
        return "", []
    clauses: List[str] = []
    params: list = []
    if start is not None:
        clauses.append("created_at >= %s")
        params.append(start)
    if end is not None:
        clauses.append("created_at < %s")
        params.append(end)
    return " AND " + " AND ".join(clauses), params


def _short_lived_ip_report(
    cur,
    *,
    settle_weeks: float,
    short_hours: float,
) -> dict:
    """Classify "throwaway" IPs and count the accounts they created.

    An IP is *short-lived* when its whole ``usage_events`` history spans less
    than ``short_hours`` (``last_event - first_event``) and its last event is
    older than ``settle_weeks`` ago — so it has had time to come back but did
    not.

    ``accounts_from_short_lived_ips`` counts the distinct accounts
    (``actor_api_key_id``) that ever acted from one of those IPs. The account
    ``bound_identity`` link is unusable here (set on almost no keys), so the
    account↔IP relationship is taken from the ``usage_events`` log itself.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(weeks=settle_weeks)
    max_span = timedelta(hours=short_hours)
    cur.execute(
        """
        WITH ip_spans AS (
            SELECT ip_hash,
                   MIN(created_at) AS first_seen,
                   MAX(created_at) AS last_seen
              FROM usage_events
             WHERE ip_hash IS NOT NULL
             GROUP BY ip_hash
        ),
        settled AS (
            -- IPs that have gone quiet long enough to judge (last event < cutoff).
            SELECT ip_hash, last_seen - first_seen AS span
              FROM ip_spans
             WHERE last_seen < %s
        ),
        short_lived AS (
            SELECT ip_hash FROM settled WHERE span < %s
        )
        SELECT
            (SELECT COUNT(*) FROM settled)::bigint      AS settled_ips,
            (SELECT COUNT(*) FROM short_lived)::bigint  AS short_lived_ips,
            (SELECT COUNT(DISTINCT ue.actor_api_key_id)
               FROM usage_events ue
              WHERE ue.actor_api_key_id IS NOT NULL
                AND ue.ip_hash IN (SELECT ip_hash FROM short_lived))::bigint
                                                        AS accounts_from_short_lived_ips
        """,
        (cutoff, max_span),
    )
    row = cur.fetchone()
    return {
        "settle_weeks": settle_weeks,
        "short_usage_hours": short_hours,
        "cutoff": cutoff.isoformat(),
        "settled_ips": int(row[0]),
        "short_lived_ips": int(row[1]),
        "accounts_from_short_lived_ips": int(row[2]),
    }


def run(
    *,
    start: Optional[datetime],
    end: Optional[datetime],
    as_json: bool,
    settle_weeks: float,
    short_hours: float,
) -> int:
    db.init_db()
    if not db.is_available():
        print(
            "Database not configured — set SUPABASE_DB_URL / DATABASE_URL "
            "(and APP_ENV to pick the right .env file).",
            file=sys.stderr,
        )
        return 1

    windowed = start is not None or end is not None
    per_table: List[dict] = []
    short_lived: Optional[dict] = None

    with db.get_conn() as conn:
        with conn.cursor() as cur:
            tables = _discover_ip_hash_tables(cur)
            if not tables:
                print("No tables with an 'ip_hash' column were found.", file=sys.stderr)
                return 1

            union_parts: List[str] = []
            union_params: list = []

            for table, has_created_at in tables:
                where, params = _window_clause(has_created_at, start, end)
                cur.execute(
                    f"SELECT COUNT(DISTINCT ip_hash)::bigint "
                    f"FROM {table} WHERE ip_hash IS NOT NULL{where}",
                    params,
                )
                count = int(cur.fetchone()[0])
                table_windowed = windowed and has_created_at
                per_table.append(
                    {
                        "table": table,
                        "distinct_ips": count,
                        "windowed": table_windowed,
                    }
                )
                union_parts.append(
                    f"SELECT ip_hash FROM {table} WHERE ip_hash IS NOT NULL{where}"
                )
                union_params.extend(params)

            union_sql = (
                "SELECT COUNT(*)::bigint FROM ("
                + " UNION ".join(union_parts)
                + ") AS all_hashes"
            )
            cur.execute(union_sql, union_params)
            global_total = int(cur.fetchone()[0])

            # Short-lived IP analysis relies on usage_events' event history.
            if any(t == "usage_events" for t, _ in tables):
                short_lived = _short_lived_ip_report(
                    cur, settle_weeks=settle_weeks, short_hours=short_hours
                )

    result = {
        "from": start.isoformat() if start else None,
        "to": end.isoformat() if end else None,
        "per_table": per_table,
        "distinct_ips_total": global_total,
        "short_lived": short_lived,
    }

    if as_json:
        print(json.dumps(result, indent=2))
        return 0

    _print_human(result, windowed)
    return 0


def _print_human(result: dict, windowed: bool) -> None:
    rng = ""
    if result["from"] or result["to"]:
        rng = f"  (window: {result['from'] or '…'} → {result['to'] or '…'})"
    print(f"Distinct IPs by table{rng}")
    print("-" * 56)
    name_w = max((len(r["table"]) for r in result["per_table"]), default=5)
    for r in result["per_table"]:
        note = ""
        if windowed and not r["windowed"]:
            note = "  (no created_at — full table)"
        print(f"  {r['table']:<{name_w}}  {r['distinct_ips']:>12,d}{note}")
    print("-" * 56)
    print(
        f"  {'TOTAL (distinct across all tables)':<{name_w}}  "
        f"{result['distinct_ips_total']:>12,d}"
    )

    sl = result.get("short_lived")
    if sl:
        settled = sl["settled_ips"]
        short = sl["short_lived_ips"]
        pct = (100.0 * short / settled) if settled else 0.0
        hrs = sl["short_usage_hours"]
        wks = sl["settle_weeks"]
        print()
        print(
            f"Short-lived IPs  (total usage span < {hrs:g}h, "
            f"quiet for {wks:g}+ weeks)"
        )
        print("-" * 56)
        print(f"  judged IPs (settled before cutoff)   {settled:>12,d}")
        print(f"  short-lived IPs                       {short:>12,d}  ({pct:.1f}%)")
        print(f"  accounts created by those IPs         {sl['accounts_from_short_lived_ips']:>12,d}")


def _parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--from", dest="frm", default=None, help="ISO start (inclusive), e.g. 2026-09-01")
    p.add_argument("--to", dest="to", default=None, help="ISO end (exclusive), e.g. 2026-10-01")
    p.add_argument(
        "--short-usage-hours",
        type=float,
        default=12.0,
        help="Max total usage span (last_event - first_event) for an IP to count as "
        "short-lived. Default: 12.",
    )
    p.add_argument(
        "--settle-weeks",
        type=float,
        default=3.0,
        help="Only judge IPs whose last event is at least this many weeks old (so "
        "returning visitors are excluded). Default: 3.",
    )
    p.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    return p.parse_args(argv)


if __name__ == "__main__":
    args = _parse_args()
    raise SystemExit(
        run(
            start=_parse_iso(args.frm),
            end=_parse_iso(args.to),
            as_json=args.json,
            settle_weeks=args.settle_weeks,
            short_hours=args.short_usage_hours,
        )
    )

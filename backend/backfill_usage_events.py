"""One-shot backfill for the ``usage_events`` analytics table.

Seeds historical rows from existing source-of-truth tables so the admin
"Usage" dashboard has data to chart from day one. Designed to be safe to
re-run: idempotency is enforced via either ``--purge`` (truncate first)
or a per-batch ``WHERE NOT EXISTS`` guard keyed on
``(event_type, created_at, actor_api_key_id, metadata)``.

Usage:
    python backfill_usage_events.py             # incremental seed
    python backfill_usage_events.py --purge     # truncate + reseed
    python backfill_usage_events.py --dry-run   # report counts only

Run from the ``backend/`` directory (or anywhere — ``app.config`` reads
the same env vars the API uses).
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from typing import Iterable, List, Optional, Tuple

# Ensure ``backend/`` is on sys.path so ``app.*`` imports resolve when this
# script is invoked from any cwd.
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.core import database as db  # noqa: E402  (after path tweak)


logger = logging.getLogger("backfill_usage_events")


# ---------------------------------------------------------------------------
# Source-table specs.
#
# Each spec is a SQL fragment that returns rows shaped like:
#     (created_at, event_type, category, actor_api_key_id, metadata_jsonb)
#
# ``metadata`` is built inline with ``jsonb_build_object`` so the row hash
# used for dedupe is stable across runs.
# ---------------------------------------------------------------------------

_SOURCES: List[Tuple[str, str]] = [
    (
        "contributions.submitted",
        """
        SELECT created_at,
               'contribution.submitted'::text     AS event_type,
               'contribution'::text                AS category,
               submitted_by_key_id::text           AS actor_api_key_id,
               jsonb_build_object(
                   'contribution_id', id,
                   'tile_count',      tile_count
               )                                   AS metadata
          FROM contributions
        """,
    ),
    (
        "contributions.approved",
        """
        SELECT approved_at,
               'admin.contribution.approve'::text  AS event_type,
               'admin'::text                       AS category,
               NULL::text                          AS actor_api_key_id,
               jsonb_build_object(
                   'contribution_id', id,
                   'target',          id
               )                                   AS metadata
          FROM contributions
         WHERE approved_at IS NOT NULL
        """,
    ),
    (
        "contributions.withdrawn",
        """
        SELECT withdrawn_at,
               'contribution.withdrawn'::text      AS event_type,
               'contribution'::text                AS category,
               submitted_by_key_id::text           AS actor_api_key_id,
               jsonb_build_object('contribution_id', id) AS metadata
          FROM contributions
         WHERE withdrawn_at IS NOT NULL
        """,
    ),
    (
        "landmarks_audit",
        """
        SELECT created_at,
               ('landmark.' || action)::text       AS event_type,
               'contribution'::text                AS category,
               actor_api_key_id::text              AS actor_api_key_id,
               jsonb_build_object('landmark_id', landmark_id) AS metadata
          FROM landmarks_audit
        """,
    ),
    (
        "translocators_audit",
        """
        SELECT created_at,
               ('translocator.' || action)::text   AS event_type,
               'contribution'::text                AS category,
               actor_api_key_id::text              AS actor_api_key_id,
               jsonb_build_object('segment_id', segment_id) AS metadata
          FROM translocators_audit
        """,
    ),
    (
        "traders_audit",
        """
        SELECT created_at,
               ('trader.' || action)::text         AS event_type,
               'contribution'::text                AS category,
               actor_api_key_id::text              AS actor_api_key_id,
               jsonb_build_object(
                   'trader_id',    trader_id,
                   'source',       source,
                   'trader_type',  trader_type
               )                                   AS metadata
          FROM traders_audit
        """,
    ),
    (
        "tl_screenshot_requests",
        """
        SELECT created_at,
               'tl_screenshot.uploaded'::text      AS event_type,
               'contribution'::text                AS category,
               submitter_api_key_id::text          AS actor_api_key_id,
               jsonb_build_object('request_id', id) AS metadata
          FROM translocator_screenshot_requests
        """,
    ),
    (
        "admin_audit_log",
        """
        SELECT al.created_at,
               ('admin.' || al.action)::text       AS event_type,
               'admin'::text                       AS category,
               ak.id::text                         AS actor_api_key_id,
               COALESCE(al.metadata, '{}'::jsonb)
                 || jsonb_build_object('target', al.target) AS metadata
          FROM admin_audit_log al
          LEFT JOIN api_keys ak ON ak.key = al.admin_key
        """,
    ),
    (
        "backup_download_log",
        """
        SELECT redeemed_at AS created_at,
               CASE WHEN success
                    THEN 'backup.redeemed'
                    ELSE 'backup.redeem_failed'
               END::text                           AS event_type,
               'download'::text                    AS category,
               NULL::text                          AS actor_api_key_id,
               jsonb_build_object(
                   'link_id',         link_id,
                   'failure_reason',  failure_reason
               )                                   AS metadata
          FROM backup_download_log
        """,
    ),
    (
        "ip_bans",
        """
        SELECT banned_at AS created_at,
               'ban.created'::text                 AS event_type,
               'moderation'::text                  AS category,
               NULL::text                          AS actor_api_key_id,
               jsonb_build_object(
                   'reason_code', reason_code,
                   'expires_at',  expires_at
               )                                   AS metadata
          FROM ip_bans
        """,
    ),
    (
        "user_flags.created",
        """
        SELECT created_at,
               'flag.created'::text                AS event_type,
               'moderation'::text                  AS category,
               NULL::text                          AS actor_api_key_id,
               jsonb_build_object('flag_id', id, 'reason', reason) AS metadata
          FROM user_flags
        """,
    ),
    (
        "user_flags.resolved",
        """
        SELECT resolved_at AS created_at,
               'flag.resolved'::text               AS event_type,
               'moderation'::text                  AS category,
               NULL::text                          AS actor_api_key_id,
               jsonb_build_object('flag_id', id, 'resolution', resolution) AS metadata
          FROM user_flags
         WHERE resolved_at IS NOT NULL
        """,
    ),
]


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def _table_exists(cur, name: str) -> bool:
    cur.execute(
        "SELECT 1 FROM information_schema.tables WHERE table_name = %s",
        (name,),
    )
    return cur.fetchone() is not None


def _seed_one(cur, label: str, sql: str, *, purge_mode: bool, dry_run: bool) -> int:
    """Insert rows from ``sql`` into ``usage_events``.

    When ``purge_mode`` is True we assume the destination table was just
    truncated so a straight INSERT is safe. Otherwise we guard with
    ``WHERE NOT EXISTS`` against the same composite signature.
    """
    if dry_run:
        cur.execute(f"SELECT COUNT(*) FROM ({sql}) src WHERE src.created_at IS NOT NULL")
        return int(cur.fetchone()[0])

    if purge_mode:
        cur.execute(
            f"""INSERT INTO usage_events
                    (created_at, event_type, category, actor_api_key_id, metadata)
                SELECT src.created_at, src.event_type, src.category,
                       src.actor_api_key_id, src.metadata
                  FROM ({sql}) src
                 WHERE src.created_at IS NOT NULL"""
        )
    else:
        cur.execute(
            f"""INSERT INTO usage_events
                    (created_at, event_type, category, actor_api_key_id, metadata)
                SELECT src.created_at, src.event_type, src.category,
                       src.actor_api_key_id, src.metadata
                  FROM ({sql}) src
                 WHERE src.created_at IS NOT NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM usage_events ue
                        WHERE ue.event_type = src.event_type
                          AND ue.created_at = src.created_at
                          AND COALESCE(ue.actor_api_key_id::text, '') =
                              COALESCE(src.actor_api_key_id, '')
                          AND COALESCE(ue.metadata, '{{}}'::jsonb) =
                              COALESCE(src.metadata, '{{}}'::jsonb)
                   )"""
        )
    return cur.rowcount


def run(*, purge: bool, dry_run: bool) -> int:
    logging.basicConfig(
        format="%(asctime)s %(levelname)s %(message)s",
        level=logging.INFO,
    )
    db.init_db()
    if not db.is_available():
        logger.error("Database not configured — set SUPABASE_DB_URL / DATABASE_URL.")
        return 1

    started = time.monotonic()
    grand_total = 0
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            if not _table_exists(cur, "usage_events"):
                logger.error(
                    "usage_events table missing — run `alembic upgrade head` first."
                )
                return 2

            if purge:
                if dry_run:
                    logger.info("[dry-run] would TRUNCATE usage_events first")
                else:
                    logger.info("Purging usage_events …")
                    cur.execute("TRUNCATE TABLE usage_events RESTART IDENTITY")

            for label, sql in _SOURCES:
                # Skip sources whose source table is absent (older deployments).
                first_word = sql.strip().split()
                # find the FROM token to discover the source table name
                src_table: Optional[str] = None
                tokens = sql.split()
                for i, tok in enumerate(tokens):
                    if tok.upper() == "FROM" and i + 1 < len(tokens):
                        src_table = tokens[i + 1].strip().rstrip(",")
                        break
                if src_table and not _table_exists(cur, src_table):
                    logger.warning("skip %s — source table %s missing", label, src_table)
                    continue
                try:
                    count = _seed_one(
                        cur, label, sql, purge_mode=purge, dry_run=dry_run
                    )
                except Exception as exc:  # noqa: BLE001
                    # Don't let one bad source abort the whole backfill.
                    conn.rollback()
                    logger.exception("source %s failed: %s", label, exc)
                    continue
                grand_total += count
                logger.info(
                    "%s%s: %d rows",
                    "[dry-run] " if dry_run else "",
                    label,
                    count,
                )

    elapsed = time.monotonic() - started
    logger.info(
        "Done. %s rows %s in %.1fs",
        f"{grand_total:,}",
        "would be inserted" if dry_run else "processed",
        elapsed,
    )
    return 0


def _parse_args(argv: Optional[Iterable[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--purge",
        action="store_true",
        help="Truncate usage_events before reseeding. Mutually exclusive with the "
             "default WHERE-NOT-EXISTS dedupe path.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Report per-source row counts without writing.",
    )
    return p.parse_args(list(argv) if argv is not None else None)


if __name__ == "__main__":
    args = _parse_args()
    raise SystemExit(run(purge=args.purge, dry_run=args.dry_run))

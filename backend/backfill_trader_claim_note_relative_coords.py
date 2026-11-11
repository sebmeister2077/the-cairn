"""One-shot fix for trader-claim audit notes that recorded ABSOLUTE
coordinates instead of map-relative ones.

Trader-claim audit rows in ``map_features_traders_audit`` carry a human note
like::

    claim 504336:113:548783 · type artisan · source manual

The ``x:y:z`` triple was copied straight from the claim id, which is a
quantised *absolute* world centre. Humans (and the in-game HUD / webmap) read
map-relative coordinates, so the x and z components must have the map middle
subtracted. ``y`` is an altitude and stays as-is. After the fix the same row
reads::

    claim -7664:113:36783 · type artisan · source manual

The note-writing code was corrected to do this going forward; this script
rewrites the historical rows.

Idempotency / safety:
  * A tracking table ``trader_claim_note_coord_migration`` records every row
    this script rewrites (with the original note), so re-runs skip already
    migrated rows and the change is auditable / reversible.
  * ``--before`` limits processing to rows created before a cutoff so notes
    written by the *fixed* code (already relative) are never touched. It
    defaults to the moment the script starts — pass the deploy time of the
    fix to be precise.
  * Nothing is written unless ``--apply`` is given; the default is a dry run
    that only reports what would change.

Usage (run from the ``backend/`` directory, or anywhere — ``app.config``
reads the same env vars the API uses):

    python backfill_trader_claim_note_relative_coords.py                     # dry run
    python backfill_trader_claim_note_relative_coords.py --apply             # commit
    python backfill_trader_claim_note_relative_coords.py --before 2026-11-11T17:00:00Z --apply
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import sys
from datetime import datetime, timezone
from typing import Optional

# Ensure ``backend/`` is on sys.path so ``app.*`` imports resolve from any cwd.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.core import database as db  # noqa: E402  (after path tweak)
from app.core.database import _claim_id_to_relative_coords  # noqa: E402


logger = logging.getLogger("backfill_trader_claim_note_relative_coords")

# Matches a "claim x:y:z" prefix (integer triple) at the start of a note,
# capturing the id triple and whatever trails it (" · type … · source …").
_NOTE_RE = re.compile(r"^claim (-?\d+:-?\d+:-?\d+)(.*)$", re.DOTALL)


def _convert_note(note: Optional[str]) -> Optional[str]:
    """Return the note with the claim id triple converted to map-relative
    coordinates, or ``None`` if the note is not a claim note / already looks
    unconvertible."""
    if not note:
        return None
    m = _NOTE_RE.match(note)
    if not m:
        return None
    claim_id, rest = m.group(1), m.group(2)
    rel = _claim_id_to_relative_coords(claim_id)
    if rel == claim_id:
        return None  # could not parse → leave untouched
    return f"claim {rel}{rest}"


def _ensure_tracking_table(cur) -> None:
    cur.execute(
        """CREATE TABLE IF NOT EXISTS trader_claim_note_coord_migration (
               audit_id    BIGINT PRIMARY KEY,
               old_note    TEXT NOT NULL,
               new_note    TEXT NOT NULL,
               migrated_at TIMESTAMPTZ NOT NULL DEFAULT now()
           )"""
    )


def run(*, before: datetime, apply: bool) -> int:
    logging.basicConfig(
        format="%(asctime)s %(levelname)s %(message)s",
        level=logging.INFO,
    )
    db.init_db()
    if not db.is_available():
        logger.error("Database not configured — set SUPABASE_DB_URL / DATABASE_URL.")
        return 1

    logger.info(
        "%s rows in map_features_traders_audit with a claim note created before %s",
        "Rewriting" if apply else "[dry-run] inspecting",
        before.isoformat(),
    )

    scanned = converted = skipped_tracked = unchanged = 0
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            if apply:
                _ensure_tracking_table(cur)

            cur.execute(
                """SELECT a.id, a.note
                       FROM map_features_traders_audit a
                      WHERE a.note LIKE 'claim %%'
                        AND a.created_at < %s
                        AND NOT EXISTS (
                            SELECT 1 FROM trader_claim_note_coord_migration m
                             WHERE m.audit_id = a.id
                        )
                      ORDER BY a.id"""
                if _table_exists(cur, "trader_claim_note_coord_migration")
                else """SELECT a.id, a.note
                            FROM map_features_traders_audit a
                           WHERE a.note LIKE 'claim %%'
                             AND a.created_at < %s
                           ORDER BY a.id""",
                (before,),
            )
            rows = cur.fetchall()

            for audit_id, note in rows:
                scanned += 1
                new_note = _convert_note(note)
                if new_note is None or new_note == note:
                    unchanged += 1
                    continue
                converted += 1
                if converted <= 10:
                    logger.info("id=%s\n  - %s\n  + %s", audit_id, note, new_note)
                if apply:
                    cur.execute(
                        "UPDATE map_features_traders_audit SET note = %s WHERE id = %s",
                        (new_note, audit_id),
                    )
                    cur.execute(
                        """INSERT INTO trader_claim_note_coord_migration
                               (audit_id, old_note, new_note)
                           VALUES (%s, %s, %s)
                           ON CONFLICT (audit_id) DO NOTHING""",
                        (audit_id, note, new_note),
                    )
        if apply:
            conn.commit()

    logger.info(
        "Done. scanned=%d converted=%d unchanged=%d%s",
        scanned,
        converted,
        unchanged,
        "" if apply else "  (dry-run — pass --apply to write)",
    )
    return 0


def _table_exists(cur, name: str) -> bool:
    cur.execute("SELECT to_regclass(%s) IS NOT NULL", (f"public.{name}",))
    return bool(cur.fetchone()[0])


def _parse_before(value: Optional[str]) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    text = value.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--before",
        default=None,
        help=(
            "ISO-8601 cutoff; only rows created before this are converted. "
            "Defaults to now. Pass the deploy time of the note fix so rows "
            "already written with relative coords are never touched."
        ),
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually write the changes. Without it the script is a dry run.",
    )
    args = parser.parse_args()
    return run(before=_parse_before(args.before), apply=args.apply)


if __name__ == "__main__":
    raise SystemExit(main())

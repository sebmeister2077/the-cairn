"""Merge two Vintage Story local map .db files into one.

Each .db file is a SQLite database with:
  - mappiece (position INTEGER PRIMARY KEY, data BLOB)  — map tile data
  - blockidmapping (id INTEGER PRIMARY KEY, data BLOB)  — block ID mapping (often empty)

Usage:
    python merge_maps.py map-databases/my-map.db map-databases/map-from-someone-else.db -o merged.db

When both databases contain a tile at the same position, you can choose which
one wins with --on-conflict (default: keep the tile from the first/primary db).
"""

import argparse
import os
import shutil
import sqlite3
import sys

MAPPIECE_TABLE = "mappiece"
BLOCKIDMAPPING_TABLE = "blockidmapping"


def validate_db(path: str) -> None:
    """Check that the file is a valid VS map database."""
    if not os.path.isfile(path):
        sys.exit(f"Error: file not found: {path}")

    conn = sqlite3.connect(path)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (MAPPIECE_TABLE,),
        )
        if not cur.fetchone():
            sys.exit(
                f"Error: {path} is not a valid Vintage Story map database "
                f"(missing '{MAPPIECE_TABLE}' table)"
            )
    finally:
        conn.close()


def count_pieces(conn: sqlite3.Connection) -> int:
    return conn.execute(f"SELECT COUNT(*) FROM {MAPPIECE_TABLE}").fetchone()[0]


def merge_databases(
    primary_path: str,
    secondary_path: str,
    output_path: str,
    on_conflict: str,
    batch_size: int,
) -> dict:
    """Merge secondary map database into a copy of the primary.

    Returns stats about the merge operation.
    """
    # Start by copying the primary database as the output
    shutil.copy2(primary_path, output_path)

    out_conn = sqlite3.connect(output_path)
    sec_conn = sqlite3.connect(secondary_path)

    try:
        primary_count = count_pieces(out_conn)
        secondary_count = count_pieces(sec_conn)

        # Ensure blockidmapping table exists in output
        out_conn.execute(
            f"CREATE TABLE IF NOT EXISTS {BLOCKIDMAPPING_TABLE} "
            f"(id INTEGER PRIMARY KEY, data BLOB)"
        )

        # Determine the INSERT statement based on conflict strategy
        if on_conflict == "primary":
            # Ignore rows from secondary that conflict with primary
            insert_sql = (
                f"INSERT OR IGNORE INTO {MAPPIECE_TABLE} (position, data) VALUES (?, ?)"
            )
        elif on_conflict == "secondary":
            # Secondary overwrites primary on conflict
            insert_sql = (
                f"INSERT OR REPLACE INTO {MAPPIECE_TABLE} (position, data) VALUES (?, ?)"
            )
        else:
            sys.exit(f"Error: unknown conflict strategy: {on_conflict}")

        # Merge mappiece rows in batches
        cur = sec_conn.execute(f"SELECT position, data FROM {MAPPIECE_TABLE}")
        inserted = 0
        skipped = 0

        while True:
            rows = cur.fetchmany(batch_size)
            if not rows:
                break

            if on_conflict == "primary":
                # Check which positions already exist to count skipped
                for pos, data in rows:
                    existing = out_conn.execute(
                        f"SELECT 1 FROM {MAPPIECE_TABLE} WHERE position = ?", (pos,)
                    ).fetchone()
                    if existing:
                        skipped += 1
                    else:
                        out_conn.execute(insert_sql, (pos, data))
                        inserted += 1
            else:
                # secondary wins — count existing as "overwritten"
                for pos, data in rows:
                    existing = out_conn.execute(
                        f"SELECT 1 FROM {MAPPIECE_TABLE} WHERE position = ?", (pos,)
                    ).fetchone()
                    if existing:
                        skipped -= 1  # will be counted as overwritten below
                    out_conn.execute(insert_sql, (pos, data))
                    inserted += 1
                skipped = abs(skipped)  # normalize

            out_conn.commit()

        # Merge blockidmapping rows (INSERT OR IGNORE — primary wins)
        blockid_inserted = 0
        sec_cur = sec_conn.execute(
            f"SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (BLOCKIDMAPPING_TABLE,),
        )
        if sec_cur.fetchone():
            bid_cur = sec_conn.execute(
                f"SELECT id, data FROM {BLOCKIDMAPPING_TABLE}"
            )
            while True:
                rows = bid_cur.fetchmany(batch_size)
                if not rows:
                    break
                for id_val, data in rows:
                    try:
                        out_conn.execute(
                            f"INSERT OR IGNORE INTO {BLOCKIDMAPPING_TABLE} (id, data) VALUES (?, ?)",
                            (id_val, data),
                        )
                        blockid_inserted += 1
                    except sqlite3.IntegrityError:
                        pass
                out_conn.commit()

        # Vacuum to reclaim space
        out_conn.execute("VACUUM")

        final_count = count_pieces(out_conn)

        return {
            "primary_tiles": primary_count,
            "secondary_tiles": secondary_count,
            "tiles_added": inserted,
            "conflicts_skipped": skipped,
            "blockid_rows_added": blockid_inserted,
            "output_tiles": final_count,
        }

    finally:
        sec_conn.close()
        out_conn.close()


def main():
    parser = argparse.ArgumentParser(
        description="Merge two Vintage Story local map .db files into one.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python merge_maps.py map-databases/my-map.db map-databases/map-from-someone-else.db\n"
            "  python merge_maps.py a.db b.db -o combined.db --on-conflict secondary\n"
            "  python merge_maps.py a.db b.db --batch-size 5000 --dry-run\n"
        ),
    )
    parser.add_argument(
        "primary",
        help="Path to the primary .db file (its tiles take priority by default).",
    )
    parser.add_argument(
        "secondary",
        help="Path to the secondary .db file to merge in.",
    )
    parser.add_argument(
        "-o", "--output",
        default="merged-map.db",
        help="Path for the merged output .db file (default: merged-map.db).",
    )
    parser.add_argument(
        "--on-conflict",
        choices=["primary", "secondary"],
        default="primary",
        help=(
            "Which database wins when both have a tile at the same position. "
            "'primary' keeps the first db's tile (default), "
            "'secondary' overwrites with the second db's tile."
        ),
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=2000,
        help="Number of rows to process per batch (default: 2000).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show merge stats without writing the output file.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite the output file if it already exists.",
    )

    args = parser.parse_args()

    # Validate inputs
    validate_db(args.primary)
    validate_db(args.secondary)

    if os.path.abspath(args.primary) == os.path.abspath(args.secondary):
        sys.exit("Error: primary and secondary files are the same.")

    if os.path.abspath(args.output) in (
        os.path.abspath(args.primary),
        os.path.abspath(args.secondary),
    ):
        sys.exit("Error: output path must differ from the input files.")

    if os.path.exists(args.output) and not args.force and not args.dry_run:
        sys.exit(
            f"Error: output file already exists: {args.output}\n"
            f"Use --force to overwrite."
        )

    if args.dry_run:
        # Just show stats for both databases
        for label, path in [("Primary", args.primary), ("Secondary", args.secondary)]:
            conn = sqlite3.connect(path)
            count = count_pieces(conn)
            conn.close()
            print(f"{label}: {path} — {count:,} tiles")

        # Count overlapping positions
        p_conn = sqlite3.connect(args.primary)
        s_conn = sqlite3.connect(args.secondary)
        p_positions = set(
            r[0] for r in p_conn.execute(f"SELECT position FROM {MAPPIECE_TABLE}")
        )
        s_positions = set(
            r[0] for r in s_conn.execute(f"SELECT position FROM {MAPPIECE_TABLE}")
        )
        p_conn.close()
        s_conn.close()

        overlap = len(p_positions & s_positions)
        combined = len(p_positions | s_positions)
        print(f"\nOverlapping positions: {overlap:,}")
        print(f"Unique combined tiles: {combined:,}")
        print(f"Conflict strategy: {args.on_conflict}")
        print(f"\n(dry run — no output file written)")
        return

    print(f"Merging maps...")
    print(f"  Primary:   {args.primary}")
    print(f"  Secondary: {args.secondary}")
    print(f"  Output:    {args.output}")
    print(f"  Conflicts: keep {args.on_conflict}")
    print()

    stats = merge_databases(
        args.primary,
        args.secondary,
        args.output,
        args.on_conflict,
        args.batch_size,
    )

    print(f"Done!")
    print(f"  Primary tiles:    {stats['primary_tiles']:,}")
    print(f"  Secondary tiles:  {stats['secondary_tiles']:,}")
    print(f"  Tiles added:      {stats['tiles_added']:,}")
    print(f"  Conflicts:        {stats['conflicts_skipped']:,} (kept {args.on_conflict})")
    if stats["blockid_rows_added"]:
        print(f"  Block ID rows:    {stats['blockid_rows_added']:,}")
    print(f"  Output total:     {stats['output_tiles']:,} tiles")
    print(f"  Output file:      {args.output}")


if __name__ == "__main__":
    main()

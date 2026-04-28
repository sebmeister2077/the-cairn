"""Initialise the TOPS map stats cache in the database from globalservermap.db.

Downloads the combined map .db from R2, computes its stats, and persists
them via ``db.set_tops_map_stats`` / ``db.set_cached_tile_count``. Does
not render or upload any PNG cache.

Usage:
  python pregenerate_tops_map_cache.py
"""

import sys
import time

from app.core import r2_storage
from app.core import database as db
from app.core.mapdb import get_map_stats


def main() -> int:
    started = time.time()
    print(f"Downloading {r2_storage.COMBINED_DB_KEY} from R2...")
    try:
        db_bytes = r2_storage.download_bytes(r2_storage.COMBINED_DB_KEY)
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}")
        return 1

    try:
        stats = get_map_stats(db_bytes)
    except Exception as exc:
        print(f"ERROR: Failed to compute map stats: {exc}")
        return 1

    try:
        db.init_db()
        db.ensure_schema()
        db.set_tops_map_stats(stats)
        db.set_cached_tile_count(int(stats.get("pieces", 0)))
    except Exception as exc:
        print(f"ERROR: Failed to persist map stats cache: {exc}")
        return 1
    finally:
        try:
            db.close_db()
        except Exception:
            pass

    elapsed = time.time() - started
    print(
        "Map stats: "
        f"{stats.get('pieces', 0)} pieces, "
        f"{stats.get('width_chunks', 0)}x{stats.get('height_chunks', 0)} chunks"
    )
    print(f"Done in {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())

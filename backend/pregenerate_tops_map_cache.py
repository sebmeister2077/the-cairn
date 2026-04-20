"""Generate and upload a pre-rendered TOPS map PNG cache to R2.

Usage:
  python pregenerate_tops_map_cache.py
  python pregenerate_tops_map_cache.py --max-dimension 4096
"""

import argparse
import sys
import time

from app.core import r2_storage
from app.core import database as db
from app.core.mapdb import get_map_stats, render_map_png


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pre-generate TOPS map cache image from globalservermap.db"
    )
    parser.add_argument(
        "--max-dimension",
        type=int,
        default=r2_storage.TOPS_MAP_CACHE_DIM,
        help="Max image dimension in pixels (default: 4096)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    max_dim = max(256, min(args.max_dimension, 16384))
    cache_key = r2_storage.tops_map_cache_key(max_dim)

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

    print(
        "Map stats: "
        f"{stats.get('pieces', 0)} pieces, "
        f"{stats.get('width_chunks', 0)}x{stats.get('height_chunks', 0)} chunks"
    )

    print(f"Rendering PNG (max_dimension={max_dim})...")
    try:
        png_bytes = render_map_png(db_bytes, max_dimension=max_dim)
    except ValueError as exc:
        print(f"ERROR: {exc}")
        return 1

    print(f"Uploading cache to R2 key: {cache_key}")
    r2_storage.upload_bytes(cache_key, png_bytes, content_type="image/png")

    elapsed = time.time() - started
    size_mb = len(png_bytes) / (1024 * 1024)
    print(f"Done. Uploaded {size_mb:.2f} MB in {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())

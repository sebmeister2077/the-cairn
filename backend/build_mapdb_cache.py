"""Build / rebuild a sidecar RGBA cache for a map .db.

Tier 3.2 (May 2026): the sidecar at ``<db_path>.cache.db`` stores
pre-decoded, zstd-compressed RGBA tiles. When fresh, the render pipeline
in :mod:`backend.app.core.mapdb` reads tiles from the cache and skips the
per-tile varint decode entirely.

Usage::

    python backend/build_mapdb_cache.py path/to/combined.db
    python backend/build_mapdb_cache.py path/to/combined.db --output other/path.cache.db

The cache is rebuilt from scratch every call (the script unlinks any
existing sidecar first). Incremental refreshes after a contribution merge
are handled by :func:`backend.app.core.mapdb_cache.incremental_update_cache`,
called from the merge approval flow — running this script by hand is only
needed for the initial build or after a full reroll.
"""

from __future__ import annotations

import argparse
import os
import sys
import time

# Allow ``python backend/build_mapdb_cache.py …`` from the repo root.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from backend.app.core.mapdb_cache import build_cache, cache_path_for  # noqa: E402


def _human_bytes(n: int) -> str:
    for unit in ("B", "KiB", "MiB", "GiB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TiB"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("source", help="Path to the source .db (e.g. combined.db)")
    p.add_argument(
        "--output",
        "-o",
        help="Cache path (default: <source>.cache.db)",
        default=None,
    )
    p.add_argument(
        "--batch-size",
        type=int,
        default=4000,
        help="Tiles per executemany batch (default 4000)",
    )
    args = p.parse_args()

    if not os.path.isfile(args.source):
        print(f"error: source not found: {args.source}", file=sys.stderr)
        return 2

    cache_path = args.output or cache_path_for(args.source)
    print(f"Building cache: {args.source}\n             -> {cache_path}")

    last_print = [0.0]

    def progress(done: int, total: int) -> None:
        now = time.time()
        if now - last_print[0] < 0.5 and done != total:
            return
        last_print[0] = now
        pct = (done / total * 100.0) if total else 100.0
        print(f"  {done:>10}/{total} tiles ({pct:5.1f}%)", flush=True)

    t0 = time.time()
    stats = build_cache(args.source, cache_path, batch_size=args.batch_size, progress=progress)
    elapsed = time.time() - t0
    print(
        f"Done in {elapsed:.1f}s: {stats['tiles']} tiles, "
        f"cache={_human_bytes(stats['cache_bytes'])} "
        f"(source={_human_bytes(stats['source_bytes'])}, "
        f"ratio={stats['ratio']:.2%})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

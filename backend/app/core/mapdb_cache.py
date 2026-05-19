"""Sidecar RGBA tile cache (Tier 3.2, May 2026).

The canonical ``mappiece`` tile blob is 11264 bytes per tile (1024 pixels ×
11 bytes — one protobuf tag plus a 10-byte ARGB varint per pixel). Roughly
two-thirds of those bytes are wasted on the always-``0xFF`` alpha channel
and the per-pixel tag byte. Decoding them via numpy is fast in absolute
terms but still dominates render wall-time on multi-GiB maps because we
re-decode the same tiles for every regen pass and every preview.

This module ships a *transparent* sidecar cache:

* A second SQLite file (``<source>.cache.db``) is created alongside the
  canonical combined.db. It mirrors the ``position`` PK but stores
  pre-decoded raw RGBA tiles (4096 bytes uncompressed → ~600 bytes when
  compressed with zstd level 3 on real-world tiles).
* Read paths in :mod:`backend.app.core.mapdb` check for a sidecar with
  :func:`open_cache_if_present`. If found and the canonical DB's mtime is
  ≤ the cache's mtime, render uses the cached RGBA directly and skips the
  numpy varint decode. Otherwise the cache is ignored and the canonical
  decode runs (so a stale cache is always safe — it's just not used).
* The cache is rebuilt offline via ``backend/build_mapdb_cache.py`` and
  incrementally refreshed by :func:`incremental_update_cache` after each
  contribution merge.

Expected wall-time impact on the tops-map regen hot path: an additional
~2× on top of Tier 1+4.1 once the cache is warm. The cache itself is
~10–15% the size of the canonical .db (vs. ~50% for the raw .db inside a
.zst sibling).
"""

from __future__ import annotations

import os
import sqlite3
from typing import Iterable, Iterator, Optional, Tuple

import numpy as np

from .compression import _zstd
from .mapdb import (
    BYTES_PER_PIXEL,
    POSITION_BITS,
    POSITION_MASK,
    STANDARD_BLOB_SIZE,
    TILE_PIXELS,
    TILE_SIZE,
    _open_mapdb_readonly,
    _open_mapdb_writable,
    decode_tile_fallback,
    decode_tile_numpy,
)

CACHE_SUFFIX = ".cache.db"
CACHE_TABLE = "cache_mappiece"
CACHE_SCHEMA = (
    f"CREATE TABLE IF NOT EXISTS {CACHE_TABLE} "
    "(position INTEGER PRIMARY KEY, rgba_zstd BLOB NOT NULL)"
)
RAW_RGBA_BYTES = TILE_PIXELS * 4  # 4096

ZSTD_LEVEL = int(os.environ.get("MAPDB_CACHE_ZSTD_LEVEL", "3"))


def zstd_compress_bytes(data: bytes, *, level: int = ZSTD_LEVEL) -> bytes:
    """Compress ``data`` with zstd at the given level (single-shot, no frame
    headers tuned for streaming \u2014 we're storing one independent blob per
    tile so per-blob seeking is what we want)."""
    cctx = _zstd().ZstdCompressor(level=level)
    return cctx.compress(data)


def zstd_decompress_bytes(data: bytes) -> bytes:
    dctx = _zstd().ZstdDecompressor()
    return dctx.decompress(data)


# ---------------------------------------------------------------------------
# Path conventions
# ---------------------------------------------------------------------------

def cache_path_for(src_db_path: str) -> str:
    """Return the conventional sidecar cache path for a source .db."""
    return src_db_path + CACHE_SUFFIX


def is_cache_fresh(src_db_path: str, cache_db_path: str) -> bool:
    """Cache is fresh iff it exists and its mtime is ≥ the source mtime.

    The mtime check is a coarse heuristic: any write to combined.db bumps
    its mtime, so a stale cache is automatically invalidated. Incremental
    updates that touch the cache *after* the source must call
    :func:`os.utime` on the source to keep the relationship monotone — see
    :func:`incremental_update_cache`.
    """
    if not os.path.isfile(cache_db_path):
        return False
    try:
        src_mtime = os.path.getmtime(src_db_path)
        cache_mtime = os.path.getmtime(cache_db_path)
    except OSError:
        return False
    return cache_mtime >= src_mtime


# ---------------------------------------------------------------------------
# Read API
# ---------------------------------------------------------------------------

def open_cache_if_present(src_db_path: str) -> Optional[sqlite3.Connection]:
    """Return a read-only connection to the sidecar cache, or None.

    Returns None if the cache file doesn't exist or is stale. Callers may
    use the returned connection in conjunction with the source DB; tile
    decoders should fall back to the canonical decode whenever a position
    is missing from the cache (the cache may be incomplete during an
    incremental rebuild).
    """
    cache_path = cache_path_for(src_db_path)
    if not is_cache_fresh(src_db_path, cache_path):
        return None
    try:
        return _open_mapdb_readonly(cache_path)
    except sqlite3.OperationalError:
        return None


def decode_cached_tile(blob: bytes) -> np.ndarray:
    """Inverse of :func:`_encode_for_cache` — returns (32, 32, 4) uint8."""
    raw = zstd_decompress_bytes(blob)
    if len(raw) != RAW_RGBA_BYTES:
        raise ValueError(
            f"Cached tile has unexpected size {len(raw)} (expected {RAW_RGBA_BYTES})"
        )
    return np.frombuffer(raw, dtype=np.uint8).reshape(TILE_SIZE, TILE_SIZE, 4)


# ---------------------------------------------------------------------------
# Write API
# ---------------------------------------------------------------------------

def _encode_for_cache(blob: bytes) -> bytes:
    """Decode a canonical tile blob → zstd-compressed raw RGBA."""
    if len(blob) == STANDARD_BLOB_SIZE:
        tile = decode_tile_numpy(blob)
    else:
        tile = decode_tile_fallback(blob)
    return zstd_compress_bytes(tile.tobytes(), level=ZSTD_LEVEL)


def _ensure_cache_schema(conn: sqlite3.Connection) -> None:
    conn.execute(CACHE_SCHEMA)
    conn.commit()


def build_cache(
    src_db_path: str,
    cache_db_path: Optional[str] = None,
    *,
    batch_size: int = 4000,
    progress=None,
) -> dict:
    """(Re)build the sidecar cache for ``src_db_path``.

    Streams tiles from the source, decodes + zstd-compresses each, and
    inserts them via :meth:`sqlite3.Connection.executemany`. The cache
    file is rebuilt from scratch (any previous content is dropped) so the
    output is guaranteed consistent with the source at call time.

    ``progress`` is an optional callable ``(done, total) -> None`` invoked
    every ``batch_size`` rows for CLI status output.

    Returns a stats dict with ``tiles``, ``cache_bytes``, ``ratio``.
    """
    cache_db_path = cache_db_path or cache_path_for(src_db_path)
    # Truncate any previous cache so a partial earlier build doesn't leak
    # stale rows.
    try:
        os.unlink(cache_db_path)
    except FileNotFoundError:
        pass

    src = _open_mapdb_readonly(src_db_path)
    dst = _open_mapdb_writable(cache_db_path)
    try:
        _ensure_cache_schema(dst)
        total = src.execute("SELECT COUNT(*) FROM mappiece").fetchone()[0] or 0
        done = 0
        cur = src.execute("SELECT position, data FROM mappiece")

        def _batches() -> Iterator[list[Tuple[int, bytes]]]:
            while True:
                rows = cur.fetchmany(batch_size)
                if not rows:
                    return
                yield rows

        for rows in _batches():
            encoded = [(int(pos), _encode_for_cache(blob)) for pos, blob in rows]
            dst.executemany(
                f"INSERT OR REPLACE INTO {CACHE_TABLE} (position, rgba_zstd) VALUES (?, ?)",
                encoded,
            )
            dst.commit()
            done += len(rows)
            if progress is not None:
                try:
                    progress(done, total)
                except Exception:
                    pass

        # Bump cache mtime to be strictly ≥ source mtime so freshness
        # check passes even on filesystems with second-resolution mtimes.
        src_mtime = os.path.getmtime(src_db_path)
        os.utime(cache_db_path, (src_mtime, src_mtime))

        cache_bytes = os.path.getsize(cache_db_path)
        src_bytes = os.path.getsize(src_db_path)
        return {
            "tiles": done,
            "cache_bytes": cache_bytes,
            "source_bytes": src_bytes,
            "ratio": (cache_bytes / src_bytes) if src_bytes else 0.0,
        }
    finally:
        src.close()
        dst.close()


def incremental_update_cache(
    src_db_path: str,
    positions: Iterable[int],
    *,
    cache_db_path: Optional[str] = None,
) -> int:
    """Refresh ``positions`` in the sidecar cache.

    Called by the contribute approval flow with the set of newly-merged
    positions. If the cache file doesn't exist yet this is a no-op — the
    next full :func:`build_cache` will pick everything up.

    Returns the number of cache rows updated.
    """
    cache_db_path = cache_db_path or cache_path_for(src_db_path)
    if not os.path.isfile(cache_db_path):
        return 0

    positions = list({int(p) for p in positions})
    if not positions:
        return 0

    src = _open_mapdb_readonly(src_db_path)
    dst = _open_mapdb_writable(cache_db_path)
    try:
        _ensure_cache_schema(dst)
        updated = 0
        # SQLite has a ~999 host-parameter limit by default. Chunk to stay
        # under it.
        CHUNK = 800
        for i in range(0, len(positions), CHUNK):
            sub = positions[i:i + CHUNK]
            placeholders = ",".join("?" * len(sub))
            rows = src.execute(
                f"SELECT position, data FROM mappiece WHERE position IN ({placeholders})",
                sub,
            ).fetchall()
            if not rows:
                continue
            encoded = [(int(pos), _encode_for_cache(blob)) for pos, blob in rows]
            dst.executemany(
                f"INSERT OR REPLACE INTO {CACHE_TABLE} (position, rgba_zstd) VALUES (?, ?)",
                encoded,
            )
            updated += len(encoded)
        dst.commit()

        # Re-stamp the cache mtime so the freshness check still passes
        # after this incremental write (which would otherwise bump cache
        # mtime past source mtime — fine — but if the caller updated the
        # source *after* the cache, the cache would look stale).
        src_mtime = os.path.getmtime(src_db_path)
        os.utime(cache_db_path, (max(src_mtime, os.path.getmtime(cache_db_path)),) * 2)
        return updated
    finally:
        src.close()
        dst.close()

"""Decode Vintage Story client map .db files into PNG images.

Uses numpy for vectorized pixel decoding — each tile blob is 1024 protobuf
varint-encoded ARGB pixels at a fixed 11 bytes per pixel (1 tag + 10 varint).
"""

import io
import sqlite3
import tempfile
import os
import random
from typing import Iterator, Optional, Tuple, Dict

import numpy as np

TILE_SIZE = 32
TILE_PIXELS = TILE_SIZE * TILE_SIZE  # 1024
BYTES_PER_PIXEL = 11  # 0x08 tag (1) + 10-byte varint (0xFF alpha → always 10)
STANDARD_BLOB_SIZE = TILE_PIXELS * BYTES_PER_PIXEL  # 11264
POSITION_BITS = 27
POSITION_MASK = (1 << POSITION_BITS) - 1
DEFAULT_MAP_MIDDLE = 512000  # VS default world center in blocks (1024000 / 2)

# ---------------------------------------------------------------------------
# Multi-resolution caching configuration
# ---------------------------------------------------------------------------

# Resolution levels for the TOPS map cache. Level 1 = lowest detail (fastest
# load), higher levels = more detail. Each value is the maximum image dimension
# (width or height) in pixels. The renderer auto-downscales tiles to fit.
RESOLUTION_LEVELS: Dict[int, int] = {
    1: 2048,
    2: 4096,
    3: 8192,
    4: 16384,
    # Level 5 — "every pixel" / full resolution. Set well above the largest
    # plausible explored map side so ``compute_level_geometry`` always picks
    # scale=1 (1 image pixel per world block). Matches VS's max world size
    # of 1,024,000 blocks and stays divisible by every configured grid size.
    5: 1048576,
}

# Default level served to non-admin viewers on first load.
DEFAULT_RESOLUTION_LEVEL = 2

# Number of chunks per side for each level's chunked grid
# (grid × grid PNGs uploaded to R2 per level). Picked per-level so high-detail
# levels stay below browser/CDN-friendly per-chunk sizes: a level-5 image of a
# fully explored map is ~8000²+ pixels, so a 16×16 grid produced single chunks
# in the tens of MB. A 64×64 grid keeps each chunk well below ~5 MB.
# IMPORTANT: when increasing the grid for an existing level, run a full regen
# so the orphan-cleanup pass in ``generate_map_levels._generate_level``
# wipes out chunks at coords that no longer fit.
CHUNK_GRID_SIZES: Dict[int, int] = {
    1: 16,
    2: 16,
    3: 16,
    4: 32,
    5: 64,
}

# Backwards-compatible default for callers that don't have a level handy.
# Prefer ``get_chunk_grid_size(level)`` or ``geometry["chunk_grid"]``.
CHUNK_GRID_SIZE = 16


def get_level_dimension(level: int) -> int:
    """Return the max image dimension for a given resolution level."""
    if level not in RESOLUTION_LEVELS:
        raise ValueError(f"Unknown resolution level: {level}")
    return RESOLUTION_LEVELS[level]


def get_chunk_grid_size(level: int) -> int:
    """Return the per-side chunk count for a level's grid."""
    if level not in CHUNK_GRID_SIZES:
        raise ValueError(f"Unknown resolution level: {level}")
    return CHUNK_GRID_SIZES[level]


def get_chunk_pixel_size(level: int) -> int:
    """Return the size of one chunk (one side) in pixels for a level."""
    return get_level_dimension(level) // get_chunk_grid_size(level)


# ---------------------------------------------------------------------------
# Connection openers (Tier 1 perf rewrite — May 2026)
# ---------------------------------------------------------------------------
#
# Previously ``_open_mapdb`` only set ``temp_store=FILE`` and a 16 MB cache,
# and ``_open_mapdb_readonly`` was the only opener that enabled mmap. Every
# call site has now been routed through openers that:
#
#   * use ``mode=ro&immutable=1`` whenever the caller does not write,
#   * enable ``journal_mode=WAL`` + ``synchronous=NORMAL`` on writers so
#     readers don't block during a merge,
#   * enable a 1 GiB mmap window and 64 MiB page cache,
#   * keep temp data in RAM (``temp_store=MEMORY``).
#
# Estimated wall-clock impact: 1.5–3× on read paths (preview, render,
# validate), ~2× on contribution merges. The old opener body is kept below
# as ``_open_mapdb_legacy`` so a reroll can wire it back in one line.

_READ_CACHE_KIB = int(os.environ.get("MAPDB_READ_CACHE_KIB", "65536"))     # 64 MiB
_WRITE_CACHE_KIB = int(os.environ.get("MAPDB_WRITE_CACHE_KIB", "131072"))  # 128 MiB
_MMAP_BYTES = int(os.environ.get("MAPDB_MMAP_BYTES", str(1024 * 1024 * 1024)))  # 1 GiB


def _abs_uri(db_path: str, query: str) -> str:
    """Build a SQLite ``file:`` URI from a local path on any OS."""
    abs_path = os.path.abspath(db_path).replace("\\", "/")
    if not abs_path.startswith("/"):
        abs_path = "/" + abs_path
    return f"file:{abs_path}?{query}"


def _apply_read_pragmas(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute("PRAGMA temp_store = MEMORY")
    cur.execute(f"PRAGMA cache_size = -{_READ_CACHE_KIB}")
    cur.execute(f"PRAGMA mmap_size = {_MMAP_BYTES}")
    cur.execute("PRAGMA query_only = 1")


def _apply_write_pragmas(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    # WAL lets readers run concurrently with the writer, and avoids the
    # rollback-journal fsync per commit. ``synchronous=NORMAL`` is safe
    # with WAL (durable across app crashes, only at-risk across OS crashes).
    try:
        cur.execute("PRAGMA journal_mode = WAL")
    except sqlite3.OperationalError:
        # Pre-existing rollback journal lock / read-only fs — fall back to
        # the default journal mode silently.
        pass
    cur.execute("PRAGMA synchronous = NORMAL")
    cur.execute("PRAGMA temp_store = MEMORY")
    cur.execute(f"PRAGMA cache_size = -{_WRITE_CACHE_KIB}")
    cur.execute(f"PRAGMA mmap_size = {_MMAP_BYTES}")


def _open_mapdb(db_path: str) -> sqlite3.Connection:
    """Open SQLite DB tuned for the map-piece workload.

    Despite the name this is now safe to use for both reads and writes —
    it enables WAL + ``synchronous=NORMAL`` and a fat page cache.
    Existing call sites keep working unchanged; readers that want to
    avoid any chance of a write lock should call
    :func:`_open_mapdb_readonly` instead.
    """
    conn = sqlite3.connect(db_path)
    _apply_write_pragmas(conn)
    return conn


def _open_mapdb_readonly(db_path: str) -> sqlite3.Connection:
    """Open SQLite DB read-only with ``mode=ro&immutable=1``.

    ``immutable=1`` tells SQLite the file will not change for the lifetime
    of the connection, which lets it skip locking, journal recovery, and
    file-change detection. Cuts per-query overhead noticeably for the
    map-tile rendering hot path. Caller MUST guarantee the file is not
    written to while the connection is open.

    ``check_same_thread=False`` is set so the same connection can be passed
    to a worker thread; rendering serializes its own DB access so this is
    safe (only one thread reads from the connection at a time).
    """
    uri = _abs_uri(db_path, "mode=ro&immutable=1")
    conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
    _apply_read_pragmas(conn)
    return conn


def _open_mapdb_writable(db_path: str) -> sqlite3.Connection:
    """Explicit writable opener. Alias for :func:`_open_mapdb` — kept as a
    separate name so call sites self-document intent and a future split
    (e.g. distinct connection pools per role) stays cheap to make."""
    return _open_mapdb(db_path)


# Legacy opener — kept commented for reroll. Restored = re-bind ``_open_mapdb``
# to this body.
# def _open_mapdb_legacy(db_path: str) -> sqlite3.Connection:
#     conn = sqlite3.connect(db_path)
#     cur = conn.cursor()
#     cur.execute("PRAGMA temp_store = FILE")
#     cur.execute("PRAGMA cache_size = -16384")  # 16 MB cache budget
#     return conn


# ---------------------------------------------------------------------------
# Tier 3.2 (May 2026): transparent sidecar tile-cache integration.
#
# When ``<db_path>.cache.db`` exists and is at least as new as the source DB
# we read pre-decoded RGBA tiles from the cache, skipping the per-tile
# numpy varint decode entirely. This saves ~50% of render wall-time on the
# tops-map regen hot path with no behavioural change (cache misses or stale
# cache files transparently fall back to the canonical decode below).
#
# To disable at runtime (e.g. while debugging a suspected cache bug) set
# ``MAPDB_DISABLE_CACHE=1`` in the env.
_CACHE_DISABLED = os.environ.get("MAPDB_DISABLE_CACHE", "0") in ("1", "true", "yes", "on")


def _iter_tiles_for_range(
    db_path: str,
    src_conn: sqlite3.Connection,
    pos_min: int,
    pos_max: int,
    batch_size: int = 2000,
) -> Iterator[Tuple[int, np.ndarray]]:
    """Yield ``(position, rgba_tile)`` for every tile in ``[pos_min, pos_max]``.

    Prefers the sidecar cache (raw RGBA, zstd-compressed) when fresh,
    otherwise decodes the canonical 11264-byte blob from ``src_conn``.
    Falling back to canonical for individual positions missing from the
    cache means an in-progress incremental rebuild can't cause render
    gaps."""
    cache_conn: Optional[sqlite3.Connection] = None
    if not _CACHE_DISABLED:
        try:
            from . import mapdb_cache  # local import avoids circular at module load
            cache_conn = mapdb_cache.open_cache_if_present(db_path)
        except Exception:
            cache_conn = None

    if cache_conn is None:
        cur = src_conn.cursor()
        cur.execute(
            "SELECT position, data FROM mappiece WHERE position BETWEEN ? AND ?",
            (pos_min, pos_max),
        )
        while True:
            rows = cur.fetchmany(batch_size)
            if not rows:
                return
            for pos_val, blob in rows:
                if len(blob) == STANDARD_BLOB_SIZE:
                    yield int(pos_val), decode_tile_numpy(blob)
                else:
                    yield int(pos_val), decode_tile_fallback(blob)
        return

    try:
        from .mapdb_cache import CACHE_TABLE, decode_cached_tile
        cache_cur = cache_conn.cursor()
        cache_cur.execute(
            f"SELECT position, rgba_zstd FROM {CACHE_TABLE} "
            "WHERE position BETWEEN ? AND ?",
            (pos_min, pos_max),
        )
        seen: set[int] = set()
        while True:
            rows = cache_cur.fetchmany(batch_size)
            if not rows:
                break
            for pos_val, blob in rows:
                pos_i = int(pos_val)
                seen.add(pos_i)
                try:
                    yield pos_i, decode_cached_tile(blob)
                except Exception:
                    # Corrupt cache row — fall back to canonical for this
                    # one position. Caller already handles individual
                    # misses.
                    src_cur = src_conn.cursor()
                    row = src_cur.execute(
                        "SELECT data FROM mappiece WHERE position = ?",
                        (pos_i,),
                    ).fetchone()
                    if row is not None:
                        canonical = row[0]
                        if len(canonical) == STANDARD_BLOB_SIZE:
                            yield pos_i, decode_tile_numpy(canonical)
                        else:
                            yield pos_i, decode_tile_fallback(canonical)

        # Pick up any positions present in the source but missing from the
        # cache (incremental rebuild in flight, brand-new contribution not
        # yet folded in, etc.).
        src_cur = src_conn.cursor()
        src_cur.execute(
            "SELECT position, data FROM mappiece WHERE position BETWEEN ? AND ?",
            (pos_min, pos_max),
        )
        while True:
            rows = src_cur.fetchmany(batch_size)
            if not rows:
                break
            for pos_val, blob in rows:
                pos_i = int(pos_val)
                if pos_i in seen:
                    continue
                if len(blob) == STANDARD_BLOB_SIZE:
                    yield pos_i, decode_tile_numpy(blob)
                else:
                    yield pos_i, decode_tile_fallback(blob)
    finally:
        try:
            cache_conn.close()
        except Exception:
            pass


def prune_db_to_region(
    src_path: str,
    dst_path: str,
    region: Tuple[int, int, int, int],
) -> Dict[str, int]:
    """Copy only the in-region tiles from ``src_path`` into a fresh SQLite
    at ``dst_path``.

    ``region`` is ``(min_x, max_x, min_z, max_z)`` in **world blocks**
    (inclusive). The output mirrors the Vintage Story map .db schema —
    ``mappiece(position INTEGER PRIMARY KEY, data BLOB)`` plus a copy of
    the ``blockidmapping`` table when present — so it remains a
    drop-in replacement that the existing decoders can read without
    branching.

    Used by the post-approval archive flow: when a contribution has a
    region selection, the archived copy only needs to retain the chunks
    the contributor actually intended to update. This keeps R2 storage
    proportional to the change, not to the source file size (a 1 GiB
    upload pruned to a 30×30-chunk update lands at tens of MiB).

    Returns ``{"kept_tiles": int, "src_bytes": int, "dst_bytes": int}``.
    The destination file is removed and recreated, so existing contents
    at ``dst_path`` are discarded.
    """
    rmin_x, rmax_x, rmin_z, rmax_z = region
    tx_min = rmin_x // TILE_SIZE
    tx_max = rmax_x // TILE_SIZE
    tz_min = rmin_z // TILE_SIZE
    tz_max = rmax_z // TILE_SIZE

    src_bytes = os.path.getsize(src_path) if os.path.exists(src_path) else 0
    try:
        os.unlink(dst_path)
    except OSError:
        pass

    # Use a writable opener so we get WAL + sensible pragmas while we
    # populate the file; the final VACUUM emits a clean, single-file DB
    # with no -wal/-shm siblings that callers would need to handle.
    dst = _open_mapdb_writable(dst_path)
    try:
        dst.execute(
            "CREATE TABLE IF NOT EXISTS mappiece "
            "(position INTEGER PRIMARY KEY, data BLOB NOT NULL)"
        )
        # ``blockidmapping`` is a per-world id→bytes table; the importer
        # needs it to decode tiles, so always carry it across when present.
        safe_src = src_path.replace("'", "''")
        dst.execute(f"ATTACH DATABASE '{safe_src}' AS src")
        try:
            has_blockidmap = dst.execute(
                "SELECT 1 FROM src.sqlite_master "
                "WHERE type='table' AND name='blockidmapping'"
            ).fetchone() is not None
            if has_blockidmap:
                dst.execute(
                    "CREATE TABLE IF NOT EXISTS blockidmapping "
                    "(id INTEGER PRIMARY KEY, data BLOB NOT NULL)"
                )
                dst.execute(
                    "INSERT OR IGNORE INTO main.blockidmapping (id, data) "
                    "SELECT id, data FROM src.blockidmapping"
                )

            # Region filter uses the same bit-packed encoding as the merge
            # path in ``contribute_r2._merge_into_combined``:
            #   position & POSITION_MASK -> tile x
            #   position >> POSITION_BITS -> tile z
            dst.execute(
                """INSERT OR REPLACE INTO main.mappiece (position, data)
                   SELECT position, data
                     FROM src.mappiece
                    WHERE (position & ?) BETWEEN ? AND ?
                      AND (position >> ?) BETWEEN ? AND ?""",
                (POSITION_MASK, tx_min, tx_max, POSITION_BITS, tz_min, tz_max),
            )
            kept_tiles = dst.execute(
                "SELECT COUNT(*) FROM main.mappiece"
            ).fetchone()[0] or 0
            dst.commit()
        finally:
            try:
                dst.execute("DETACH DATABASE src")
            except sqlite3.OperationalError:
                pass
    finally:
        try:
            dst.close()
        except Exception:
            pass

    # VACUUM in a fresh connection: it requires no open txns and we want
    # the resulting file to be as small as possible since the next step
    # uploads it to R2. Run with synchronous=OFF for speed — we re-verify
    # the file by opening it again below.
    vac = sqlite3.connect(dst_path)
    try:
        vac.execute("PRAGMA synchronous=OFF")
        vac.execute("VACUUM")
        vac.commit()
    finally:
        vac.close()

    dst_bytes = os.path.getsize(dst_path) if os.path.exists(dst_path) else 0
    return {
        "kept_tiles": int(kept_tiles),
        "src_bytes": int(src_bytes),
        "dst_bytes": int(dst_bytes),
    }


def encode_chunk_array_to_png(arr: Optional[np.ndarray]) -> Optional[bytes]:
    """Encode an RGBA chunk buffer to PNG bytes.

    Returns ``None`` if ``arr`` is ``None`` or fully transparent (so callers
    can skip storing/serving an empty chunk). Designed to be called from
    worker threads — Pillow releases the GIL during PNG compression.

    Uses ``compress_level=1`` (PIL default is 6). For tops-map chunks this
    cuts PNG encode wall time by roughly 3-4x at the cost of ~15-25%
    larger files. Chunks are stored in R2 (no per-byte transfer cost
    inside the same region) and served gzipped/br by Cloudflare, so the
    size delta is a non-issue while the encode time was a real bottleneck
    on full-level regens.
    """
    if arr is None:
        return None
    if not arr[..., 3].any():
        return None
    from PIL import Image
    img = Image.fromarray(arr, "RGBA")
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=False, compress_level=1)
    return out.getvalue()


def _get_map_bounds(cur: sqlite3.Cursor) -> tuple[int, int, int, int, int]:
    """Return (count, min_x, max_x, min_z, max_z) from packed positions."""
    cur.execute(
        """
        SELECT
            COUNT(*),
            MIN(position & ?),
            MAX(position & ?),
            MIN(position >> ?),
            MAX(position >> ?)
        FROM mappiece
        """,
        (POSITION_MASK, POSITION_MASK, POSITION_BITS, POSITION_BITS),
    )
    count, min_x, max_x, min_z, max_z = cur.fetchone()
    if not count:
        raise ValueError("Map database is empty")
    return int(count), int(min_x), int(max_x), int(min_z), int(max_z)


def decode_position(pos: int) -> tuple[int, int]:
    return pos & POSITION_MASK, pos >> POSITION_BITS


def decode_tile_numpy(blob: bytes) -> np.ndarray:
    """Decode a standard 11264-byte tile blob into a (32, 32, 4) uint8 RGBA array.

    Exploits the fixed 11-byte-per-pixel layout to use numpy vectorized ops
    instead of a Python varint loop. ~100x faster than pure Python.
    """
    arr = np.frombuffer(blob, dtype=np.uint8).reshape(TILE_PIXELS, BYTES_PER_PIXEL)
    # Columns 1-5 hold the lower 35 bits of each varint (we need 32)
    b = arr[:, 1:6].astype(np.uint32)
    argb = (
        (b[:, 0] & 0x7F)
        | ((b[:, 1] & 0x7F) << 7)
        | ((b[:, 2] & 0x7F) << 14)
        | ((b[:, 3] & 0x7F) << 21)
        | ((b[:, 4] & 0x7F) << 28)
    ) & 0xFFFFFFFF

    rgba = np.empty((TILE_PIXELS, 4), dtype=np.uint8)
    rgba[:, 0] = argb & 0xFF           # R (stored in B position of ABGR)
    rgba[:, 1] = (argb >> 8) & 0xFF   # G
    rgba[:, 2] = (argb >> 16) & 0xFF  # B (stored in R position of ABGR)
    rgba[:, 3] = (argb >> 24) & 0xFF   # A
    return rgba.reshape(TILE_SIZE, TILE_SIZE, 4)


def decode_tile_fallback(blob: bytes) -> np.ndarray:
    """Fallback varint decoder for non-standard blob sizes."""
    result = np.zeros((TILE_SIZE, TILE_SIZE, 4), dtype=np.uint8)
    result[:, :, 3] = 255  # default opaque black
    offset = 0
    blen = len(blob)
    px = 0
    while offset < blen and px < TILE_PIXELS:
        offset += 1  # skip tag
        if offset >= blen:
            break
        val = 0
        shift = 0
        while offset < blen:
            byte = blob[offset]
            val |= (byte & 0x7F) << shift
            offset += 1
            if (byte & 0x80) == 0:
                break
            shift += 7
        argb = val & 0xFFFFFFFF
        row, col = divmod(px, TILE_SIZE)
        result[row, col] = [argb & 0xFF, (argb >> 8) & 0xFF,
                            (argb >> 16) & 0xFF, (argb >> 24) & 0xFF]
        px += 1
    return result


def _sample_one_pixel(blob: bytes, pixel_index: int = 528) -> tuple:
    """Extract a single pixel from a standard blob using fixed stride.

    Default pixel 528 = center of the 32×32 tile (row 16, col 16).
    Returns (R, G, B, A) tuple.
    """
    off = pixel_index * BYTES_PER_PIXEL + 1  # skip tag byte
    b0 = blob[off]; b1 = blob[off+1]; b2 = blob[off+2]
    b3 = blob[off+3]; b4 = blob[off+4]
    argb = ((b0 & 0x7F) | ((b1 & 0x7F) << 7) | ((b2 & 0x7F) << 14)
            | ((b3 & 0x7F) << 21) | ((b4 & 0x7F) << 28)) & 0xFFFFFFFF
    return (argb & 0xFF, (argb >> 8) & 0xFF, (argb >> 16) & 0xFF, (argb >> 24) & 0xFF)


def _sample_n_pixels(blob: bytes, n: int, seed: int) -> list:
    """Phase 1 — sample ``n`` pseudo-random pixels plus the center pixel from
    a tile blob. The seed is the tile's ``position`` integer so the same tile
    samples the same pixels every run (reproducible scoring).

    Returns a list of (R, G, B, A) tuples of length ``n + 1`` (the trailing
    entry is always the center pixel, index 528). For non-standard blob
    sizes the function falls back to decoding via :func:`decode_tile_fallback`
    and reading ``arr[y, x]`` directly.

    Alpha=0 pixels are returned unchanged; callers are expected to skip them
    when computing similarity (treat alpha=0 as no-data).
    """
    out: list = []

    if len(blob) == STANDARD_BLOB_SIZE:
        rng = random.Random(seed)
        # Deterministic random pixel indices in [0, TILE_PIXELS).
        # We allow duplicates with the center; that's fine — the similarity
        # check counts each sampled position independently.
        for _ in range(n):
            idx = rng.randrange(TILE_PIXELS)
            out.append(_sample_one_pixel(blob, idx))
        out.append(_sample_one_pixel(blob, 528))  # center pixel
        return out

    # Non-standard blob — decode the whole tile and index into the array.
    arr = decode_tile_fallback(blob)
    rng = random.Random(seed)
    for _ in range(n):
        y = rng.randrange(TILE_SIZE)
        x = rng.randrange(TILE_SIZE)
        r, g, b, a = arr[y, x]
        out.append((int(r), int(g), int(b), int(a)))
    cy, cx = TILE_SIZE // 2, TILE_SIZE // 2
    r, g, b, a = arr[cy, cx]
    out.append((int(r), int(g), int(b), int(a)))
    return out


def render_map_png_from_path(
    db_path: str,
    max_dimension: int = 4096,
    fast_preview: bool = False,
) -> bytes:
    """Render all map pieces from a .db file path into a PNG image.

    fast_preview=True uses one sampled color per tile and paints coarse blocks.
    """
    from PIL import Image

    conn = None
    try:
        # Pure read path — use the immutable opener (Tier 1).
        conn = _open_mapdb_readonly(db_path)
        cur = conn.cursor()

        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='mappiece'")
        if not cur.fetchone():
            raise ValueError("Not a valid Vintage Story map database (no mappiece table)")

        _, min_x, max_x, min_z, max_z = _get_map_bounds(cur)

        w_chunks = max_x - min_x + 1
        h_chunks = max_z - min_z + 1
        full_w = w_chunks * TILE_SIZE
        full_h = h_chunks * TILE_SIZE

        scale = max(1, max(full_w // max_dimension, full_h // max_dimension))
        img_w = max(1, full_w // scale)
        img_h = max(1, full_h // scale)

        img_arr = np.zeros((img_h, img_w, 4), dtype=np.uint8)

        batch_size = 2000
        cur.execute("SELECT position, data FROM mappiece")

        # Choose strategy based on scale
        if fast_preview:
            tile_px = max(1, TILE_SIZE // scale)
            while True:
                rows = cur.fetchmany(batch_size)
                if not rows:
                    break
                for pos_val, blob in rows:
                    cx, cz = decode_position(pos_val)
                    bx = (cx - min_x) * TILE_SIZE // scale
                    bz = (cz - min_z) * TILE_SIZE // scale
                    if len(blob) >= STANDARD_BLOB_SIZE:
                        r, g, b, a = _sample_one_pixel(blob)
                    else:
                        r, g, b, a = 0, 0, 0, 255

                    if tile_px == 1:
                        if 0 <= bx < img_w and 0 <= bz < img_h:
                            img_arr[bz, bx] = [r, g, b, a]
                    else:
                        ex = min(img_w, bx + tile_px)
                        ez = min(img_h, bz + tile_px)
                        if ex > bx and ez > bz:
                            img_arr[bz:ez, bx:ex] = [r, g, b, a]
        elif scale <= TILE_SIZE:
            # Decode full tiles, subsample with numpy
            while True:
                rows = cur.fetchmany(batch_size)
                if not rows:
                    break
                for pos_val, blob in rows:
                    cx, cz = decode_position(pos_val)
                    if len(blob) == STANDARD_BLOB_SIZE:
                        tile = decode_tile_numpy(blob)
                    else:
                        tile = decode_tile_fallback(blob)

                    if scale == 1:
                        bx = (cx - min_x) * TILE_SIZE
                        bz = (cz - min_z) * TILE_SIZE
                        img_arr[bz:bz + TILE_SIZE, bx:bx + TILE_SIZE] = tile
                    else:
                        sampled = tile[::scale, ::scale]
                        sh, sw = sampled.shape[:2]
                        bx = (cx - min_x) * TILE_SIZE // scale
                        bz = (cz - min_z) * TILE_SIZE // scale
                        # Clamp to image bounds
                        ew = min(sw, img_w - bx)
                        eh = min(sh, img_h - bz)
                        if ew > 0 and eh > 0:
                            img_arr[bz:bz + eh, bx:bx + ew] = sampled[:eh, :ew]
        else:
            # Very high scale — one sample pixel per tile
            while True:
                rows = cur.fetchmany(batch_size)
                if not rows:
                    break
                for pos_val, blob in rows:
                    cx, cz = decode_position(pos_val)
                    bx = (cx - min_x) * TILE_SIZE // scale
                    bz = (cz - min_z) * TILE_SIZE // scale
                    if 0 <= bx < img_w and 0 <= bz < img_h:
                        if len(blob) >= STANDARD_BLOB_SIZE:
                            r, g, b, a = _sample_one_pixel(blob)
                        else:
                            r, g, b, a = 0, 0, 0, 255
                        img_arr[bz, bx] = [r, g, b, a]

        conn.close()
        conn = None

        img = Image.fromarray(img_arr, "RGBA")
        out = io.BytesIO()
        img.save(out, format="PNG")
        return out.getvalue()

    finally:
        if conn is not None:
            conn.close()


def render_map_png(db_bytes: bytes, max_dimension: int = 4096, fast_preview: bool = False) -> bytes:
    """Render all map pieces from in-memory .db bytes into a PNG image."""
    fd, tmp_path = tempfile.mkstemp(suffix=".db")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(db_bytes)
        return render_map_png_from_path(
            tmp_path,
            max_dimension=max_dimension,
            fast_preview=fast_preview,
        )
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def get_map_stats_from_path(db_path: str) -> dict:
    """Get basic stats from a map .db file path without rendering."""
    conn = None
    try:
        # Pure read path — use the immutable opener (Tier 1).
        conn = _open_mapdb_readonly(db_path)
        cur = conn.cursor()

        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='mappiece'")
        if not cur.fetchone():
            raise ValueError("Not a valid Vintage Story map database")

        cur.execute(
            """
            SELECT
                COUNT(*),
                SUM(LENGTH(data)),
                MIN(position & ?),
                MAX(position & ?),
                MIN(position >> ?),
                MAX(position >> ?)
            FROM mappiece
            """,
            (POSITION_MASK, POSITION_MASK, POSITION_BITS, POSITION_BITS),
        )
        count, total_bytes, min_x, max_x, min_z, max_z = cur.fetchone()

        conn.close()
        conn = None

        if not count:
            return {"pieces": 0, "size_mb": 0}

        return {
            "pieces": int(count),
            "size_mb": round((total_bytes or 0) / (1024 * 1024), 1),
            "width_chunks": int(max_x - min_x + 1),
            "height_chunks": int(max_z - min_z + 1),
            "width_blocks": int(max_x - min_x + 1) * TILE_SIZE,
            "height_blocks": int(max_z - min_z + 1) * TILE_SIZE,
            "start_x": int(min_x) * TILE_SIZE - DEFAULT_MAP_MIDDLE,
            "start_z": int(min_z) * TILE_SIZE - DEFAULT_MAP_MIDDLE,
        }

    finally:
        if conn is not None:
            conn.close()


def get_map_stats(db_bytes: bytes) -> dict:
    """Get basic stats from a map .db file without rendering."""
    fd, tmp_path = tempfile.mkstemp(suffix=".db")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(db_bytes)
        return get_map_stats_from_path(tmp_path)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Chunked multi-resolution rendering
# ---------------------------------------------------------------------------

def compute_level_geometry(db_path: str, level: int) -> dict:
    """Compute the rendering geometry for a given resolution level.

    Returns a dict with: scale, image_w, image_h, chunk_w, chunk_h,
    min_x, min_z (chunk coords), max_x, max_z (chunk coords),
    width_blocks, height_blocks, start_x, start_z (world block coords).
    """
    conn = _open_mapdb_readonly(db_path)
    try:
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='mappiece'")
        if not cur.fetchone():
            raise ValueError("Not a valid Vintage Story map database (no mappiece table)")
        _, min_x, max_x, min_z, max_z = _get_map_bounds(cur)
    finally:
        conn.close()

    max_dim = get_level_dimension(level)
    grid = get_chunk_grid_size(level)
    w_chunks = max_x - min_x + 1
    h_chunks = max_z - min_z + 1
    full_w = w_chunks * TILE_SIZE
    full_h = h_chunks * TILE_SIZE

    scale = max(1, max(full_w // max_dim, full_h // max_dim))
    image_w = max(1, full_w // scale)
    image_h = max(1, full_h // scale)

    # Chunk dimensions — divide image evenly into grid × grid.
    chunk_w = max(1, image_w // grid)
    chunk_h = max(1, image_h // grid)

    return {
        "scale": int(scale),
        "image_w": int(image_w),
        "image_h": int(image_h),
        "chunk_w": int(chunk_w),
        "chunk_h": int(chunk_h),
        "chunk_grid": int(grid),
        "min_x": int(min_x),
        "max_x": int(max_x),
        "min_z": int(min_z),
        "max_z": int(max_z),
        "width_blocks": int(w_chunks * TILE_SIZE),
        "height_blocks": int(h_chunks * TILE_SIZE),
        "start_x": int(min_x) * TILE_SIZE - DEFAULT_MAP_MIDDLE,
        "start_z": int(min_z) * TILE_SIZE - DEFAULT_MAP_MIDDLE,
    }


def _chunk_pixel_bounds(geometry: dict, cx: int, cy: int) -> Tuple[int, int, int, int]:
    """Return (px0, py0, px1, py1) image-pixel bounds for chunk (cx, cy).

    Last column/row absorbs any remainder pixels so the chunks fully cover
    the image.
    """
    chunk_w = geometry["chunk_w"]
    chunk_h = geometry["chunk_h"]
    img_w = geometry["image_w"]
    img_h = geometry["image_h"]
    grid = geometry.get("chunk_grid", CHUNK_GRID_SIZE)
    px0 = cx * chunk_w
    py0 = cy * chunk_h
    px1 = img_w if cx == grid - 1 else min(img_w, px0 + chunk_w)
    py1 = img_h if cy == grid - 1 else min(img_h, py0 + chunk_h)
    return px0, py0, px1, py1


def world_block_bounds_to_chunk_indices(
    geometry: dict,
    min_block_x: int,
    max_block_x: int,
    min_block_z: int,
    max_block_z: int,
) -> Tuple[int, int, int, int]:
    """Translate a world-block bounding box into inclusive chunk-grid indices.

    Returns (cx_min, cy_min, cx_max, cy_max). Clamped to [0, grid-1] using the
    grid size recorded in ``geometry``.
    Useful for partial regeneration after a contribution is merged.
    """
    scale = geometry["scale"]
    chunk_w = geometry["chunk_w"]
    chunk_h = geometry["chunk_h"]
    grid = geometry.get("chunk_grid", CHUNK_GRID_SIZE)
    map_origin_block_x = geometry["min_x"] * TILE_SIZE
    map_origin_block_z = geometry["min_z"] * TILE_SIZE

    # Convert world blocks → image pixels
    px_min = max(0, (min_block_x - map_origin_block_x)) // scale
    px_max = max(0, (max_block_x - map_origin_block_x)) // scale
    py_min = max(0, (min_block_z - map_origin_block_z)) // scale
    py_max = max(0, (max_block_z - map_origin_block_z)) // scale

    cx_min = max(0, min(grid - 1, int(px_min // chunk_w)))
    cx_max = max(0, min(grid - 1, int(px_max // chunk_w)))
    cy_min = max(0, min(grid - 1, int(py_min // chunk_h)))
    cy_max = max(0, min(grid - 1, int(py_max // chunk_h)))
    return cx_min, cy_min, cx_max, cy_max


def render_chunk_png(db_path: str, level: int, cx: int, cy: int,
                     geometry: Optional[dict] = None) -> Optional[bytes]:
    """Render a single chunk (cx, cy) of the map at the given resolution level.

    Returns the PNG bytes for the chunk, or ``None`` if the chunk has no map
    data (fully transparent). Empty chunks are intentionally not rendered so
    callers can skip storing/serving them — the frontend stitcher leaves any
    missing position transparent on its canvas, which gives the same visual
    result without paying for ~300 extra bytes per blank chunk in storage and
    bandwidth.

    Strategy: allocate the chunk's output buffer at the *target* resolution
    (``chunk_arr_h × chunk_arr_w``), then for each overlapping tile decode
    it, downsample with stride ``scale`` (``tile[::scale, ::scale]``), and
    paste it at its scale-aligned image-pixel position. This is the same
    approach the contribution preview uses and gives gap-free coverage
    even when ``scale`` does not divide ``TILE_SIZE`` evenly — adjacent
    tiles overlap by at most one pixel rather than leaving stripes of
    transparent pixels. Memory is bounded by the chunk-sized output
    buffer plus one decoded tile (~4 MB peak per worker).
    """
    from PIL import Image

    if geometry is None:
        geometry = compute_level_geometry(db_path, level)

    grid = geometry.get("chunk_grid", get_chunk_grid_size(level))
    if cx < 0 or cy < 0 or cx >= grid or cy >= grid:
        raise ValueError(f"Chunk coords out of range: ({cx},{cy})")

    scale = geometry["scale"]
    min_x = geometry["min_x"]
    min_z = geometry["min_z"]
    px0, py0, px1, py1 = _chunk_pixel_bounds(geometry, cx, cy)
    chunk_arr_w = px1 - px0
    chunk_arr_h = py1 - py0
    if chunk_arr_w <= 0 or chunk_arr_h <= 0:
        return None

    # Block-coordinate region this chunk covers (relative to map origin),
    # used to compute which tiles overlap.
    bx0 = px0 * scale
    by0 = py0 * scale
    bx1 = bx0 + chunk_arr_w * scale
    by1 = by0 + chunk_arr_h * scale

    out_arr = np.zeros((chunk_arr_h, chunk_arr_w, 4), dtype=np.uint8)

    # World-tile range that overlaps the block region.
    tx_lo = min_x + bx0 // TILE_SIZE
    tx_hi = min_x + (bx1 - 1) // TILE_SIZE
    tz_lo = min_z + by0 // TILE_SIZE
    tz_hi = min_z + (by1 - 1) // TILE_SIZE

    conn = _open_mapdb_readonly(db_path)
    try:
        # Position layout: (z << POSITION_BITS) | x → z-range maps cleanly
        # to a position range. Filter x in Python (cheap).
        pos_min = (tz_lo << POSITION_BITS) | 0
        pos_max = (tz_hi << POSITION_BITS) | POSITION_MASK

        # Tier 3.2 (May 2026): pull tiles through the cache-aware iterator
        # so a fresh sidecar cache skips the per-tile varint decode.
        for pos_val, tile in _iter_tiles_for_range(db_path, conn, pos_min, pos_max):
            tx, tz = decode_position(pos_val)
            if tx < tx_lo or tx > tx_hi:
                continue

            # Downsample tile to the level's scale. For scale=1 this
            # is the original 32x32 tile; for larger scales it's a
            # smaller patch (e.g. 16x16 at scale=2, 1x1 at scale≥32).
            sampled = tile if scale == 1 else tile[::scale, ::scale]
            sh, sw = sampled.shape[:2]

            # Image-pixel origin of this tile, relative to the chunk.
            bx = (tx - min_x) * TILE_SIZE // scale - px0
            bz = (tz - min_z) * TILE_SIZE // scale - py0

            # Clip the patch against the chunk's output buffer.
            sx0 = max(0, -bx)
            sy0 = max(0, -bz)
            ew = min(sw, chunk_arr_w - bx)
            eh = min(sh, chunk_arr_h - bz)
            if ew > sx0 and eh > sy0:
                out_arr[
                    bz + sy0:bz + eh,
                    bx + sx0:bx + ew,
                ] = sampled[sy0:eh, sx0:ew]
    finally:
        conn.close()

    # If no tile contributed any non-zero alpha, treat the chunk as empty so
    # the caller can skip uploading a ~300-byte transparent PNG.
    if not out_arr[..., 3].any():
        return None

    img = Image.fromarray(out_arr, "RGBA")
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=False)
    return out.getvalue()


def iter_chunk_coords(grid: int,
                      only_bounds: Optional[Tuple[int, int, int, int]] = None,
                      ) -> Iterator[Tuple[int, int]]:
    """Yield (cx, cy) chunk coordinates for a ``grid``×``grid`` layout.

    If only_bounds is provided as (cx_min, cy_min, cx_max, cy_max), only chunks
    inside that inclusive rectangle are yielded. Otherwise all grid² chunks
    are yielded.
    """
    if only_bounds is None:
        for cy in range(grid):
            for cx in range(grid):
                yield cx, cy
        return
    cx_min, cy_min, cx_max, cy_max = only_bounds
    for cy in range(cy_min, cy_max + 1):
        for cx in range(cx_min, cx_max + 1):
            yield cx, cy


def render_level_streaming(
    db_path: str,
    level: int,
    geometry: dict,
    only_bounds: Optional[Tuple[int, int, int, int]] = None,
) -> Iterator[Tuple[int, int, Optional[np.ndarray]]]:
    """Render chunks for one level via a single SQLite scan per chunk-row.

    Yields ``(cx, cy, rgba_array_or_None)`` as each chunk in the row finishes
    rendering. ``None`` means the chunk has no map data (caller should treat
    as transparent and skip storage). The array is a fresh ``(h, w, 4)``
    uint8 numpy buffer the caller owns.

    Compared to calling :func:`render_chunk_png` per-chunk this:

    * Issues **one** ``SELECT`` per chunk-row instead of one per chunk,
      cutting query overhead by ~``grid``× on large grids.
    * Decodes each tile blob exactly once even when its pixels feed multiple
      chunks (only happens on chunk boundaries; usually 1 chunk per tile).
    * Opens a single read-only/immutable SQLite connection for the entire
      level instead of opening+closing one per chunk.

    ``only_bounds``: ``(cx_min, cy_min, cx_max, cy_max)`` inclusive, or
    ``None`` for the full grid.

    Memory: peak ≈ ``(cx_max - cx_min + 1) × chunk_w × chunk_h × 4`` bytes
    (one row of RGBA buffers held simultaneously) plus one decoded tile.
    """
    grid = geometry["chunk_grid"]
    if only_bounds is None:
        cx_min, cy_min, cx_max, cy_max = 0, 0, grid - 1, grid - 1
    else:
        cx_min, cy_min, cx_max, cy_max = only_bounds

    scale = geometry["scale"]
    min_x = geometry["min_x"]
    min_z = geometry["min_z"]

    conn = _open_mapdb_readonly(db_path)
    try:
        for cy in range(cy_min, cy_max + 1):
            # Allocate output buffers for every chunk in this row.
            row_buffers: Dict[int, np.ndarray] = {}
            row_pixel_bounds: Dict[int, Tuple[int, int, int, int]] = {}
            for cx in range(cx_min, cx_max + 1):
                px0, py0, px1, py1 = _chunk_pixel_bounds(geometry, cx, cy)
                w = px1 - px0
                h = py1 - py0
                if w <= 0 or h <= 0:
                    yield cx, cy, None
                    continue
                row_buffers[cx] = np.zeros((h, w, 4), dtype=np.uint8)
                row_pixel_bounds[cx] = (px0, py0, px1, py1)

            if not row_buffers:
                continue

            # Block-coord extent covered by this row of chunks.
            sample_cx = next(iter(row_buffers))
            spx0, spy0, _spx1, spy1 = row_pixel_bounds[sample_cx]
            row_by0 = spy0 * scale
            row_by1 = spy1 * scale  # exclusive
            row_bx0 = min(row_pixel_bounds[c][0] for c in row_buffers) * scale
            row_bx1_excl = max(
                row_pixel_bounds[c][2] for c in row_buffers
            ) * scale

            tz_lo = min_z + row_by0 // TILE_SIZE
            tz_hi = min_z + (row_by1 - 1) // TILE_SIZE
            tx_lo = min_x + row_bx0 // TILE_SIZE
            tx_hi = min_x + (row_bx1_excl - 1) // TILE_SIZE

            pos_min = (tz_lo << POSITION_BITS) | 0
            pos_max = (tz_hi << POSITION_BITS) | POSITION_MASK

            # Tier 3.2 (May 2026): route through the cache-aware iterator
            # so warm sidecar caches skip the per-tile varint decode.
            for pos_val, tile in _iter_tiles_for_range(db_path, conn, pos_min, pos_max):
                tx, tz = decode_position(pos_val)
                if tx < tx_lo or tx > tx_hi:
                    continue

                sampled = tile if scale == 1 else tile[::scale, ::scale]
                sh, sw = sampled.shape[:2]

                # Distribute tile pixels into every chunk in the row
                # whose pixel rect this tile overlaps. On most rows this
                # touches exactly one chunk; only at chunk boundaries
                # does it touch two.
                for cx, out_arr in row_buffers.items():
                    px0, py0, _, _ = row_pixel_bounds[cx]
                    chunk_arr_h, chunk_arr_w = out_arr.shape[:2]
                    bx = (tx - min_x) * TILE_SIZE // scale - px0
                    bz = (tz - min_z) * TILE_SIZE // scale - py0
                    sx0 = max(0, -bx)
                    sy0 = max(0, -bz)
                    ew = min(sw, chunk_arr_w - bx)
                    eh = min(sh, chunk_arr_h - bz)
                    if ew > sx0 and eh > sy0:
                        out_arr[
                            bz + sy0:bz + eh,
                            bx + sx0:bx + ew,
                        ] = sampled[sy0:eh, sx0:ew]

            # Hand off finished chunks; drop our reference so the caller's
            # threadpool can free buffers as it finishes encode+upload.
            for cx in sorted(row_buffers.keys()):
                arr = row_buffers[cx]
                yield cx, cy, arr
            row_buffers.clear()
    finally:
        conn.close()


def assemble_chunks_to_png(chunk_loader, geometry: dict) -> bytes:
    """Assemble all chunks into a single full-resolution PNG.

    chunk_loader: callable(cx, cy) -> bytes (PNG bytes for that chunk),
                  or None if the chunk has not been generated yet.
    Returns the assembled PNG as bytes.

    Memory: peak ~ image_w × image_h × 4 bytes (RGBA buffer).
    """
    from PIL import Image

    img_w = geometry["image_w"]
    img_h = geometry["image_h"]
    grid = geometry.get("chunk_grid", CHUNK_GRID_SIZE)
    img_arr = np.zeros((img_h, img_w, 4), dtype=np.uint8)

    for cy in range(grid):
        for cx in range(grid):
            chunk_png = chunk_loader(cx, cy)
            if not chunk_png:
                continue
            px0, py0, px1, py1 = _chunk_pixel_bounds(geometry, cx, cy)
            try:
                with Image.open(io.BytesIO(chunk_png)) as chunk_img:
                    chunk_img.load()
                    chunk_rgba = chunk_img.convert("RGBA")
                    chunk_np = np.asarray(chunk_rgba, dtype=np.uint8)
            except Exception:
                continue
            ch_h, ch_w = chunk_np.shape[:2]
            ew = min(ch_w, px1 - px0)
            eh = min(ch_h, py1 - py0)
            if ew > 0 and eh > 0:
                img_arr[py0:py0 + eh, px0:px0 + ew] = chunk_np[:eh, :ew]

    out_img = Image.fromarray(img_arr, "RGBA")
    out = io.BytesIO()
    out_img.save(out, format="PNG", optimize=False)
    return out.getvalue()

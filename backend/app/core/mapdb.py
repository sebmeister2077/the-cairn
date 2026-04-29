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
    # of 1,024,000 blocks and stays divisible by CHUNK_GRID_SIZE (16).
    5: 1048576,
}

# Default level served to non-admin viewers on first load.
DEFAULT_RESOLUTION_LEVEL = 2

# Number of chunks per side for the chunked grid (CHUNK_GRID_SIZE × CHUNK_GRID_SIZE chunks per level).
# Allows generating one chunk at a time to keep peak memory low.
CHUNK_GRID_SIZE = 16


def get_level_dimension(level: int) -> int:
    """Return the max image dimension for a given resolution level."""
    if level not in RESOLUTION_LEVELS:
        raise ValueError(f"Unknown resolution level: {level}")
    return RESOLUTION_LEVELS[level]


def get_chunk_pixel_size(level: int) -> int:
    """Return the size of one chunk (one side) in pixels for a level."""
    return get_level_dimension(level) // CHUNK_GRID_SIZE


def _open_mapdb(db_path: str) -> sqlite3.Connection:
    """Open SQLite DB with conservative memory settings for large map files."""
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    # Keep temp data on disk and cap SQLite page cache to reduce RAM pressure.
    cur.execute("PRAGMA temp_store = FILE")
    cur.execute("PRAGMA cache_size = -16384")  # 16 MB cache budget
    return conn


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
        conn = _open_mapdb(db_path)
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
        conn = _open_mapdb(db_path)
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
    conn = _open_mapdb(db_path)
    try:
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='mappiece'")
        if not cur.fetchone():
            raise ValueError("Not a valid Vintage Story map database (no mappiece table)")
        _, min_x, max_x, min_z, max_z = _get_map_bounds(cur)
    finally:
        conn.close()

    max_dim = get_level_dimension(level)
    w_chunks = max_x - min_x + 1
    h_chunks = max_z - min_z + 1
    full_w = w_chunks * TILE_SIZE
    full_h = h_chunks * TILE_SIZE

    scale = max(1, max(full_w // max_dim, full_h // max_dim))
    image_w = max(1, full_w // scale)
    image_h = max(1, full_h // scale)

    # Chunk dimensions — divide image evenly into CHUNK_GRID_SIZE × CHUNK_GRID_SIZE
    chunk_w = max(1, image_w // CHUNK_GRID_SIZE)
    chunk_h = max(1, image_h // CHUNK_GRID_SIZE)

    return {
        "scale": int(scale),
        "image_w": int(image_w),
        "image_h": int(image_h),
        "chunk_w": int(chunk_w),
        "chunk_h": int(chunk_h),
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
    px0 = cx * chunk_w
    py0 = cy * chunk_h
    px1 = img_w if cx == CHUNK_GRID_SIZE - 1 else min(img_w, px0 + chunk_w)
    py1 = img_h if cy == CHUNK_GRID_SIZE - 1 else min(img_h, py0 + chunk_h)
    return px0, py0, px1, py1


def world_block_bounds_to_chunk_indices(
    geometry: dict,
    min_block_x: int,
    max_block_x: int,
    min_block_z: int,
    max_block_z: int,
) -> Tuple[int, int, int, int]:
    """Translate a world-block bounding box into inclusive chunk-grid indices.

    Returns (cx_min, cy_min, cx_max, cy_max). Clamped to [0, CHUNK_GRID_SIZE-1].
    Useful for partial regeneration after a contribution is merged.
    """
    scale = geometry["scale"]
    chunk_w = geometry["chunk_w"]
    chunk_h = geometry["chunk_h"]
    map_origin_block_x = geometry["min_x"] * TILE_SIZE
    map_origin_block_z = geometry["min_z"] * TILE_SIZE

    # Convert world blocks → image pixels
    px_min = max(0, (min_block_x - map_origin_block_x)) // scale
    px_max = max(0, (max_block_x - map_origin_block_x)) // scale
    py_min = max(0, (min_block_z - map_origin_block_z)) // scale
    py_max = max(0, (max_block_z - map_origin_block_z)) // scale

    cx_min = max(0, min(CHUNK_GRID_SIZE - 1, int(px_min // chunk_w)))
    cx_max = max(0, min(CHUNK_GRID_SIZE - 1, int(px_max // chunk_w)))
    cy_min = max(0, min(CHUNK_GRID_SIZE - 1, int(py_min // chunk_h)))
    cy_max = max(0, min(CHUNK_GRID_SIZE - 1, int(py_max // chunk_h)))
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

    if cx < 0 or cy < 0 or cx >= CHUNK_GRID_SIZE or cy >= CHUNK_GRID_SIZE:
        raise ValueError(f"Chunk coords out of range: ({cx},{cy})")

    if geometry is None:
        geometry = compute_level_geometry(db_path, level)

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

    conn = _open_mapdb(db_path)
    try:
        cur = conn.cursor()
        # Position layout: (z << POSITION_BITS) | x → z-range maps cleanly
        # to a position range. Filter x in Python (cheap).
        pos_min = (tz_lo << POSITION_BITS) | 0
        pos_max = (tz_hi << POSITION_BITS) | POSITION_MASK
        cur.execute(
            "SELECT position, data FROM mappiece WHERE position BETWEEN ? AND ?",
            (pos_min, pos_max),
        )

        batch_size = 2000
        while True:
            rows = cur.fetchmany(batch_size)
            if not rows:
                break
            for pos_val, blob in rows:
                tx, tz = decode_position(pos_val)
                if tx < tx_lo or tx > tx_hi:
                    continue

                if len(blob) == STANDARD_BLOB_SIZE:
                    tile = decode_tile_numpy(blob)
                else:
                    tile = decode_tile_fallback(blob)

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


def iter_chunk_coords(only_bounds: Optional[Tuple[int, int, int, int]] = None
                      ) -> Iterator[Tuple[int, int]]:
    """Yield (cx, cy) chunk coordinates for the grid.

    If only_bounds is provided as (cx_min, cy_min, cx_max, cy_max), only chunks
    inside that inclusive rectangle are yielded. Otherwise all CHUNK_GRID_SIZE²
    chunks are yielded.
    """
    if only_bounds is None:
        for cy in range(CHUNK_GRID_SIZE):
            for cx in range(CHUNK_GRID_SIZE):
                yield cx, cy
        return
    cx_min, cy_min, cx_max, cy_max = only_bounds
    for cy in range(cy_min, cy_max + 1):
        for cx in range(cx_min, cx_max + 1):
            yield cx, cy


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
    img_arr = np.zeros((img_h, img_w, 4), dtype=np.uint8)

    for cy in range(CHUNK_GRID_SIZE):
        for cx in range(CHUNK_GRID_SIZE):
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

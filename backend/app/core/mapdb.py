"""Decode Vintage Story client map .db files into PNG images.

Uses numpy for vectorized pixel decoding — each tile blob is 1024 protobuf
varint-encoded ARGB pixels at a fixed 11 bytes per pixel (1 tag + 10 varint).
"""

import io
import sqlite3
import tempfile
import os

import numpy as np

TILE_SIZE = 32
TILE_PIXELS = TILE_SIZE * TILE_SIZE  # 1024
BYTES_PER_PIXEL = 11  # 0x08 tag (1) + 10-byte varint (0xFF alpha → always 10)
STANDARD_BLOB_SIZE = TILE_PIXELS * BYTES_PER_PIXEL  # 11264
POSITION_BITS = 27
POSITION_MASK = (1 << POSITION_BITS) - 1
DEFAULT_MAP_MIDDLE = 512000  # VS default world center in blocks (1024000 / 2)


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


def render_map_png(db_bytes: bytes, max_dimension: int = 4096) -> bytes:
    """Render all map pieces from a .db file into a PNG image."""
    from PIL import Image

    fd, tmp_path = tempfile.mkstemp(suffix=".db")
    conn = None
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(db_bytes)

        conn = sqlite3.connect(tmp_path)
        cur = conn.cursor()

        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='mappiece'")
        if not cur.fetchone():
            raise ValueError("Not a valid Vintage Story map database (no mappiece table)")

        cur.execute("SELECT position FROM mappiece")
        positions = [row[0] for row in cur.fetchall()]
        if not positions:
            raise ValueError("Map database is empty")

        coords = [decode_position(p) for p in positions]
        min_x = min(c[0] for c in coords)
        max_x = max(c[0] for c in coords)
        min_z = min(c[1] for c in coords)
        max_z = max(c[1] for c in coords)

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
        if scale <= TILE_SIZE:
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
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def get_map_stats_from_path(db_path: str) -> dict:
    """Get basic stats from a map .db file path without rendering."""
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()

        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='mappiece'")
        if not cur.fetchone():
            raise ValueError("Not a valid Vintage Story map database")

        cur.execute("SELECT COUNT(*), SUM(LENGTH(data)) FROM mappiece")
        count, total_bytes = cur.fetchone()

        cur.execute("SELECT position FROM mappiece")
        chunks = [decode_position(r[0]) for r in cur.fetchall()]

        conn.close()
        conn = None

        if not chunks:
            return {"pieces": 0, "size_mb": 0}

        min_x = min(c[0] for c in chunks)
        max_x = max(c[0] for c in chunks)
        min_z = min(c[1] for c in chunks)
        max_z = max(c[1] for c in chunks)

        return {
            "pieces": count,
            "size_mb": round((total_bytes or 0) / (1024 * 1024), 1),
            "width_chunks": max_x - min_x + 1,
            "height_chunks": max_z - min_z + 1,
            "width_blocks": (max_x - min_x + 1) * TILE_SIZE,
            "height_blocks": (max_z - min_z + 1) * TILE_SIZE,
            "start_x": min_x * TILE_SIZE - DEFAULT_MAP_MIDDLE,
            "start_z": min_z * TILE_SIZE - DEFAULT_MAP_MIDDLE,
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

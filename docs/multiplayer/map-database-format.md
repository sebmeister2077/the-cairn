# Map database format

Everything in this section depends on understanding what's actually in a Vintage Story client map `.db`. This page documents that format at the level we rely on it. The reference implementation is in [backend/app/core/mapdb.py](../../backend/app/core/mapdb.py).

## What it is

A Vintage Story client map cache is a plain SQLite database. The game writes it to `%AppData%\VintagestoryData\Maps\<world>.db` as the player explores and the world renders. We only need two tables out of it:

- `mappiece(position INTEGER PRIMARY KEY, data BLOB)` — the actual rendered map tiles.
- `blockidmapping(id INTEGER PRIMARY KEY, data BLOB)` — block-id-to-name lookup. We carry it across merges but do not currently use its contents for rendering.

If `mappiece` is missing or empty, the file is rejected as not a valid Vintage Story map database. That's our cheap "is this really a VS map?" check.

## The `position` packing

Each `mappiece.position` is a single 64-bit integer encoding the tile's (x, z) coordinate. The encoding splits the integer at bit 27:

| Bits | Meaning |
|------|---------|
| 0..26 | tile X coordinate |
| 27..  | tile Z coordinate |

Decoded with `decode_position`:

```python
POSITION_BITS = 27
POSITION_MASK = (1 << POSITION_BITS) - 1

def decode_position(pos: int) -> (int, int):
    return pos & POSITION_MASK, pos >> POSITION_BITS
```

Tiles are 32 blocks per side (`TILE_SIZE = 32`). The world center sits at `DEFAULT_MAP_MIDDLE = 512000` blocks (i.e. `1024000 / 2`). The frontend converts back and forth between the *image-pixel* coordinate space the renderer produces and the *world-block* coordinate space the user actually cares about.

We use the packed form everywhere — set membership for "is this tile in both DBs", min/max queries for bounds, etc. — so SQLite can do it with raw integer ops instead of join logic.

## The tile blob (`data`)

Each tile is a 32×32 grid of ARGB pixels (`TILE_PIXELS = 1024`) stored as a protobuf-style varint-encoded byte sequence. In the **standard** case, every blob is exactly 11264 bytes: `1024 pixels × 11 bytes/pixel`. The 11 bytes per pixel are:

- 1 tag byte (`0x08`)
- 10 bytes of varint payload — always 10 because the alpha byte is `0xFF` and forces the high bit of the varint into a 5th continuation byte.

This fixed layout is what makes `decode_tile_numpy` viable: we can `np.frombuffer` the whole blob, reshape to `(1024, 11)` and run vectorised varint decoding columnwise. The pure-Python `decode_tile_fallback` exists for the rare cases where a tile blob *isn't* 11264 bytes (older world saves, partial writes, etc.) and we need to walk the varint sequence one byte at a time.

The decoded pixel layout is **ABGR** in memory but we re-pack it as RGBA on output, which is why R and B look swapped in `decode_tile_numpy`. That is intentional and matches what the game writes.

There is also `_sample_one_pixel`, which extracts a single pixel from a standard blob using a fixed stride. We use it when the output image is so heavily downscaled that one pixel per tile is plenty — it's roughly 1000× cheaper than decoding the full tile.

## Why we use temp files everywhere

SQLite needs a real filesystem path. Whenever a `.db` is in R2 (every contribute and TOPS-map flow), we download it to a `tempfile.mkstemp(suffix=".db")` first and `os.unlink` afterwards. That's why every helper takes a `db_path: str` argument rather than bytes. It's also why the upload paths stream the request body to disk — we never want the full file in RAM, especially since the upload size cap is hundreds of MB.

The only exception is `render_map_png` (operating on bytes) — that path exists for the legacy `tops_map_render` endpoint and is kept for very small DBs and CLI users. Everything new uses `render_map_png_from_path`.

## Resolution levels and chunk grid

Pure rendering parameters; no metadata in the `.db` itself:

```python
RESOLUTION_LEVELS = {1: 2048, 2: 4096, 3: 8192, 4: 16384, 5: 1048576}  # max image dim; L5 = full resolution (1 pixel per block)
CHUNK_GRID_SIZE = 16  # 16×16 = 256 chunks per level
DEFAULT_RESOLUTION_LEVEL = 2
```

Each resolution level is a fully rendered map at the given dimension, sliced into a 16×16 grid of PNG chunks. See [TOPS Map](./tops-map.md) for how that grid drives the actual serving pipeline.

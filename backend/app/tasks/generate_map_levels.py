"""Background task that generates multi-resolution TOPS map caches.

For each requested level:
  1. Compute the rendering geometry from globalservermap.db
  2. Render each (cx, cy) chunk and upload to R2 individually
  3. Update PostgreSQL progress tracker after each chunk
  4. Persist the level metadata (geometry + total bytes) to R2

The frontend stitches the chunks itself — no big assembled PNG is stored.
This keeps memory usage bounded to a single chunk's RGBA buffer at a time
and removes a slow R2 upload from the hot path of generation.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from typing import Dict, List, Optional, Tuple

from ..core import r2_storage
from ..core import generation_tracker as tracker
from ..core import database as db
from ..core.mapdb import (
    CHUNK_GRID_SIZE,
    RESOLUTION_LEVELS,
    compute_level_geometry,
    iter_chunk_coords,
    render_chunk_png,
    world_block_bounds_to_chunk_indices,
)

logger = logging.getLogger("uvicorn.error")

# Single in-process job lock so concurrent admin clicks don't double-launch.
_job_lock = threading.Lock()
_active_thread: Optional[threading.Thread] = None


def is_job_running() -> bool:
    return _active_thread is not None and _active_thread.is_alive()


def _download_combined_db() -> str:
    """Download globalservermap.db to a temp file and return its path."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        r2_storage.download_to_path(r2_storage.COMBINED_DB_KEY, path)
    except Exception:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise
    return path


def _generate_level(
    db_path: str,
    level: int,
    affected_bounds: Optional[Tuple[int, int, int, int]] = None,
) -> None:
    """Render and upload all chunks for one resolution level.

    affected_bounds: optional world-block (min_x, max_x, min_z, max_z). When
    provided, only chunks intersecting that area are re-rendered; existing
    chunks outside the area are reused.
    """
    geometry = compute_level_geometry(db_path, level)

    # Persist geometry as the level metadata so the API can serve it.
    metadata = {
        "level": level,
        "max_dimension": RESOLUTION_LEVELS[level],
        "image_w": geometry["image_w"],
        "image_h": geometry["image_h"],
        "chunk_w": geometry["chunk_w"],
        "chunk_h": geometry["chunk_h"],
        "chunk_grid": CHUNK_GRID_SIZE,
        "scale": geometry["scale"],
        "width_blocks": geometry["width_blocks"],
        "height_blocks": geometry["height_blocks"],
        "start_x": geometry["start_x"],
        "start_z": geometry["start_z"],
    }

    # Figure out which chunks to render this run.
    only_bounds: Optional[Tuple[int, int, int, int]] = None
    if affected_bounds is not None:
        cx_min, cy_min, cx_max, cy_max = world_block_bounds_to_chunk_indices(
            geometry, *affected_bounds,
        )
        only_bounds = (cx_min, cy_min, cx_max, cy_max)
        logger.info(
            "Level %s: partial regen, chunks (%s,%s)..(%s,%s)",
            level, cx_min, cy_min, cx_max, cy_max,
        )
    else:
        logger.info("Level %s: full regeneration of all %s chunks",
                    level, CHUNK_GRID_SIZE * CHUNK_GRID_SIZE)

    chunks_to_render = list(iter_chunk_coords(only_bounds))
    total_grid = CHUNK_GRID_SIZE * CHUNK_GRID_SIZE
    tracker.mark_started(level, total_chunks=total_grid)

    # Count already-existing chunks outside the regen window as completed.
    completed = 0
    bytes_written = 0
    if only_bounds is not None:
        completed = total_grid - len(chunks_to_render)
        tracker.update_progress(level, completed, current_chunk=None)

    for cx, cy in chunks_to_render:
        try:
            chunk_png = render_chunk_png(db_path, level, cx, cy, geometry=geometry)
            chunk_key = r2_storage.tops_map_level_chunk_key(level, cx, cy)
            if chunk_png is None:
                # Fully transparent — don't store it. Drop any pre-existing
                # object + cached presigned URL so a re-generation can erase
                # data from a previous run cleanly.
                try:
                    r2_storage.delete_object(chunk_key)
                except Exception:
                    pass
                try:
                    db.delete_chunk_url(level, cx, cy)
                except Exception:
                    pass
            else:
                r2_storage.upload_bytes(
                    chunk_key,
                    chunk_png,
                    content_type="image/png",
                )
                bytes_written += len(chunk_png)
                # Invalidate any stale presigned URL pointing at the previous
                # version of this chunk.
                try:
                    db.delete_chunk_url(level, cx, cy)
                except Exception:
                    pass
        except Exception as exc:
            logger.exception("Level %s chunk (%s,%s) failed: %s", level, cx, cy, exc)
            raise
        completed += 1
        tracker.update_progress(level, completed, current_chunk=f"{cx}-{cy}")

    # Best-effort: clean up any legacy assembled PNG so it can't be served stale.
    try:
        r2_storage.delete_object(r2_storage.tops_map_level_assembled_key(level))
    except Exception:
        pass

    metadata["size_bytes"] = bytes_written
    r2_storage.upload_bytes(
        r2_storage.tops_map_level_metadata_key(level),
        json.dumps(metadata).encode("utf-8"),
        content_type="application/json",
    )

    # Drop the in-process metadata cache so the API serves the new geometry
    # immediately instead of the stale cached copy.
    try:
        from ..routes import tops_map_r2 as _tops_map_r2
        _tops_map_r2.invalidate_level_metadata_cache(level)
    except Exception:
        pass

    tracker.mark_complete(level, size_bytes=bytes_written)
    logger.info("Level %s complete: %s bytes across %s chunks",
                level, bytes_written, total_grid)


def _run_job(levels: List[int],
             affected_bounds: Optional[Tuple[int, int, int, int]] = None):
    """Job entry point — runs in a background thread."""
    db_path: Optional[str] = None
    try:
        db_path = _download_combined_db()
        for level in levels:
            try:
                _generate_level(db_path, level, affected_bounds=affected_bounds)
            except Exception as exc:
                tracker.mark_failed(level, str(exc))
                logger.exception("Level %s generation failed", level)
                # Continue with other levels rather than aborting the batch.
    except Exception as exc:
        logger.exception("Map generation job aborted: %s", exc)
        for level in levels:
            try:
                tracker.mark_failed(level, str(exc))
            except Exception:
                pass
    finally:
        if db_path:
            try:
                os.unlink(db_path)
            except OSError:
                pass


def start_job(levels: List[int],
              affected_bounds: Optional[Tuple[int, int, int, int]] = None) -> bool:
    """Spawn the background generation thread. Returns True on launch,
    False if a job is already running."""
    global _active_thread
    with _job_lock:
        if is_job_running():
            return False
        valid_levels = [lvl for lvl in levels if lvl in RESOLUTION_LEVELS]
        if not valid_levels:
            return False
        thread = threading.Thread(
            target=_run_job,
            args=(valid_levels, affected_bounds),
            name="tops-map-generator",
            daemon=True,
        )
        _active_thread = thread
        thread.start()
        return True

"""Background task that generates multi-resolution TOPS map caches.

For each requested level:
  1. Compute the rendering geometry from globalservermap.db
  2. Render each (cx, cy) chunk and upload to R2 individually
  3. Update PostgreSQL progress tracker after each chunk
  4. Persist the level metadata (geometry + total bytes) to R2

The frontend stitches the chunks itself — no big assembled PNG is stored.
This keeps memory usage bounded to a single chunk's RGBA buffer at a time
and removes a slow R2 upload from the hot path of generation.

Job scheduling
--------------
A single in-process worker thread runs at any time. Regen requests are
persisted in the ``regen_queue`` Postgres table; producers (contribute
approvals, admin "regenerate") call :func:`start_job`, which appends a row
to the queue and starts the worker if it isn't already alive.

The worker (:func:`_worker_loop`) drains the queue, coalesces all rows into
one work plan per resolution level (union of bounding boxes, or full regen
if any row demands it), runs one pass, then drains again. Only when a drain
*under the job lock* returns no rows does the worker exit, which guarantees
that an enqueue arriving at the wrong moment cannot be lost.

This solves the original race where two contribute approvals landing within
seconds of each other meant the second one's chunk regen was silently
skipped because ``start_job`` saw a worker already running and returned
``False`` without recording the pending bounds anywhere.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Dict, List, Optional, Tuple

from ..core import r2_storage
from ..core import generation_tracker as tracker
from ..core import database as db
from ..core.mapdb import (
    RESOLUTION_LEVELS,
    compute_level_geometry,
    encode_chunk_array_to_png,
    iter_chunk_coords,
    render_chunk_png,
    render_level_streaming,
    world_block_bounds_to_chunk_indices,
)

logger = logging.getLogger("uvicorn.error")


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# Opt-in switch for the parallelized regen pipeline. When enabled, each level
# is rendered with:
#   * One read-only/immutable SQLite scan per chunk-row instead of one query
#     per chunk (mapdb.render_level_streaming).
#   * A ThreadPoolExecutor that performs PNG encode + R2 upload concurrently
#     so the next row's rendering overlaps with the previous row's I/O.
# Disabled by default — set TOPS_MAP_PARALLEL_REGEN=1 in the worker env to
# turn it on.
PARALLEL_REGEN = _env_bool("TOPS_MAP_PARALLEL_REGEN", default=False)

# Worker pool size for PNG encode + upload. Capped at 8 because the
# bottleneck above that is usually outbound bandwidth, not CPU.
PARALLEL_REGEN_WORKERS = max(
    1,
    min(
        int(os.environ.get("TOPS_MAP_PARALLEL_REGEN_WORKERS", "0") or 0)
        or min(8, (os.cpu_count() or 2)),
        16,
    ),
)

# Single in-process job lock so concurrent admin clicks don't double-launch.
_job_lock = threading.Lock()
_active_thread: Optional[threading.Thread] = None

# Cooperative stop signal. Set by ``request_stop()`` (admin STOP button);
# checked by the worker between chunks and between queue passes. When
# observed, the worker marks the in-flight level as failed with a clear
# message, drains and discards any queued requests so they don't immediately
# resume the work the admin just asked to stop, then exits.
_stop_event = threading.Event()


# Sentinel exception raised inside ``_generate_level`` to unwind the chunk
# loop when a stop is requested. Caught in ``_worker_loop``.
class _StopRequested(Exception):
    pass


def request_stop() -> bool:
    """Signal the running worker to stop after the current chunk.

    Returns ``True`` if a worker was running (and will observe the signal),
    ``False`` if no worker is alive — in which case the flag is still set
    and will be cleared by the next ``start_job`` call.
    """
    _stop_event.set()
    return is_job_running()


def is_stop_requested() -> bool:
    return _stop_event.is_set()


def clear_stop():
    _stop_event.clear()


def is_job_running() -> bool:
    return _active_thread is not None and _active_thread.is_alive()


def _download_combined_db() -> str:
    """Return a path to a local copy of globalservermap.db. Reuses the
    shared cached copy maintained by
    :func:`backend.app.routes.contribute_r2.get_combined_db_cached` so a
    regen pass shares one ~900 MB download with concurrent preview /
    region-preview / match-score requests instead of doing its own.

    The returned path must be treated as read-only — the regen worker
    only reads from it (renders chunks) so this is safe. Caller MUST NOT
    delete the file.
    """
    from ..routes.contribute_r2 import get_combined_db_cached
    return get_combined_db_cached()


def _snapshot_combined_db() -> str:
    """Copy the shared cached combined.db to a worker-private path.

    The shared cache returned by :func:`get_combined_db_cached` is
    *atomically replaced in place* whenever another caller (e.g. the
    approval merge flow uploading a new combined.db) observes an ETag
    change. If the regen worker held only the shared path string for the
    duration of a multi-level pass, levels rendered after such a swap
    would silently use a different DB — producing per-level
    ``metadata.json`` files whose ``start_x``/``width_blocks`` disagree
    with each other and with the global stats, which manifests on the
    frontend as overlay waypoints appearing shifted on some levels.

    Taking a private copy at the start of each pass pins the DB snapshot
    for the whole pass so every level renders consistently. The copy is
    deleted at the end of the pass.
    """
    src = _download_combined_db()
    # Place the snapshot next to the shared cache so it lives on the same
    # (large) persistent disk the cache uses, not on /tmp which on Render
    # is small.
    snap_dir = os.path.dirname(src) or tempfile.gettempdir()
    snap_path = os.path.join(
        snap_dir, f"combined.regen-snapshot.{os.getpid()}.{int(time.time())}.db"
    )
    t0 = time.time()
    shutil.copyfile(src, snap_path)
    logger.info(
        "Combined DB snapshot pinned for regen pass: %s -> %s (%.1f MiB in %.2fs)",
        src,
        snap_path,
        os.path.getsize(snap_path) / (1024 * 1024),
        time.time() - t0,
    )
    return snap_path


def refresh_level_metadata(levels: Optional[List[int]] = None) -> Dict[int, dict]:
    """Recompute and re-upload ``metadata.json`` for the given levels without
    re-rendering any chunks.

    This is a cheap repair for the case where per-level ``metadata.json``
    bounds drifted out of sync with the current ``combined.db`` (e.g. a
    contribution was approved mid-regen-pass and only some levels got the
    new geometry written). Each level's tiles already cover the new world
    region thanks to per-chunk addressing; only the geometry header was
    stale, so rewriting it is enough to fix overlay alignment in the
    frontend.

    The previous metadata's ``size_bytes`` field is preserved (since we
    are not re-rendering chunks we can't recompute it accurately).
    Returns a dict mapping ``level -> new_metadata`` for every level
    successfully refreshed.
    """
    if levels is None:
        levels_to_refresh = sorted(RESOLUTION_LEVELS.keys())
    else:
        levels_to_refresh = sorted(
            {lvl for lvl in levels if lvl in RESOLUTION_LEVELS}
        )
        if not levels_to_refresh:
            return {}

    # Single private snapshot for the whole batch so every level sees the
    # same DB state — same reasoning as ``_snapshot_combined_db`` for the
    # full-regen worker.
    snap_path = _snapshot_combined_db()
    refreshed: Dict[int, dict] = {}
    try:
        for level in levels_to_refresh:
            try:
                geometry = compute_level_geometry(snap_path, level)
            except Exception:
                logger.exception(
                    "refresh_level_metadata: level %s geometry compute failed",
                    level,
                )
                continue

            metadata = {
                "level": level,
                "max_dimension": RESOLUTION_LEVELS[level],
                "image_w": geometry["image_w"],
                "image_h": geometry["image_h"],
                "chunk_w": geometry["chunk_w"],
                "chunk_h": geometry["chunk_h"],
                "chunk_grid": geometry["chunk_grid"],
                "scale": geometry["scale"],
                "width_blocks": geometry["width_blocks"],
                "height_blocks": geometry["height_blocks"],
                "start_x": geometry["start_x"],
                "start_z": geometry["start_z"],
            }

            # Preserve size_bytes from previous metadata when present so the
            # admin UI doesn't flip to 0 after a metadata-only refresh.
            try:
                prev_raw = r2_storage.download_bytes(
                    r2_storage.tops_map_level_metadata_key(level)
                )
                prev_meta = json.loads(prev_raw.decode("utf-8"))
                if "size_bytes" in prev_meta:
                    metadata["size_bytes"] = prev_meta["size_bytes"]
            except FileNotFoundError:
                pass
            except Exception:
                logger.exception(
                    "refresh_level_metadata: could not read previous "
                    "metadata.json for level %s (continuing)", level,
                )

            try:
                r2_storage.upload_bytes(
                    r2_storage.tops_map_level_metadata_key(level),
                    json.dumps(metadata).encode("utf-8"),
                    content_type="application/json",
                )
            except Exception:
                logger.exception(
                    "refresh_level_metadata: upload failed for level %s",
                    level,
                )
                continue

            try:
                from ..routes import tops_map_r2 as _tops_map_r2
                _tops_map_r2.invalidate_level_metadata_cache(level)
            except Exception:
                pass

            refreshed[level] = metadata
            logger.info(
                "refresh_level_metadata: level %s metadata refreshed "
                "(start_x=%s width_blocks=%s)",
                level, metadata["start_x"], metadata["width_blocks"],
            )
    finally:
        if snap_path and os.path.exists(snap_path):
            try:
                os.unlink(snap_path)
            except OSError:
                logger.exception(
                    "refresh_level_metadata: failed to delete snapshot %s",
                    snap_path,
                )

    return refreshed


def _encode_and_upload_chunk(
    level: int,
    cx: int,
    cy: int,
    arr,  # Optional[np.ndarray]
) -> int:
    """Worker-thread task: PNG-encode one chunk's RGBA buffer and upload it
    to R2. For empty/transparent chunks, deletes any pre-existing object so
    the cache reflects the new state. Returns the number of bytes written
    (0 for empty chunks).

    Both Pillow's PNG encoder and boto3's HTTPS upload release the GIL for
    the bulk of their work, so calling this from many threads in parallel
    yields real speedup.
    """
    chunk_key = r2_storage.tops_map_level_chunk_key(level, cx, cy)
    png = encode_chunk_array_to_png(arr)
    if png is None:
        try:
            r2_storage.delete_object(chunk_key)
        except Exception:
            pass
        try:
            db.delete_chunk_url(level, cx, cy)
        except Exception:
            pass
        return 0
    r2_storage.upload_bytes(chunk_key, png, content_type="image/png")
    try:
        db.delete_chunk_url(level, cx, cy)
    except Exception:
        pass
    return len(png)


def _render_level_parallel(
    db_path: str,
    level: int,
    geometry: dict,
    only_bounds: Optional[Tuple[int, int, int, int]],
    initial_completed: int,
    total_grid: int,
) -> Tuple[int, int]:
    """Parallel render path: streams chunk RGBA buffers from one SQLite scan
    per chunk-row and fans encode+upload out to a thread pool.

    Returns ``(bytes_written, completed)``. Honours :func:`is_stop_requested`
    between submissions and raises :class:`_StopRequested` if signaled.
    """
    grid = geometry["chunk_grid"]
    if only_bounds is None:
        bounds_for_streaming: Optional[Tuple[int, int, int, int]] = None
    else:
        bounds_for_streaming = only_bounds

    bytes_written = 0
    completed = initial_completed
    workers = PARALLEL_REGEN_WORKERS
    # Cap in-flight encode/upload tasks so a slow R2 doesn't let the
    # generator outrun the pool and balloon memory with queued PNG buffers.
    max_in_flight = max(workers * 2, 4)
    in_flight: List[Tuple[int, int, "Future[int]"]] = []

    progress_lock = threading.Lock()
    last_logged_chunk: Dict[str, str] = {"key": ""}

    def _drain_one() -> None:
        nonlocal bytes_written, completed
        cx_done, cy_done, fut = in_flight.pop(0)
        try:
            written = fut.result()
        except Exception:
            logger.exception(
                "Level %s chunk (%s,%s) failed in parallel encode/upload",
                level, cx_done, cy_done,
            )
            raise
        with progress_lock:
            bytes_written += written
            completed += 1
            last_logged_chunk["key"] = f"{cx_done}-{cy_done}"
            tracker.update_progress(
                level, completed, current_chunk=last_logged_chunk["key"]
            )

    logger.info(
        "Level %s: parallel regen path enabled (workers=%s, row-stripe scan)",
        level, workers,
    )

    with ThreadPoolExecutor(
        max_workers=workers,
        thread_name_prefix=f"tops-map-l{level}",
    ) as executor:
        try:
            for cx, cy, arr in render_level_streaming(
                db_path, level, geometry, bounds_for_streaming,
            ):
                if is_stop_requested():
                    raise _StopRequested(
                        f"stopped at level {level} after "
                        f"{completed}/{total_grid} chunks"
                    )
                fut = executor.submit(
                    _encode_and_upload_chunk, level, cx, cy, arr,
                )
                in_flight.append((cx, cy, fut))
                # Backpressure: keep the in-flight queue bounded.
                while len(in_flight) >= max_in_flight:
                    _drain_one()
        except _StopRequested:
            # Don't wait on outstanding uploads — let executor cancel/exit
            # via __exit__ (it will still wait for currently running tasks
            # to finish, which is what we want for write consistency).
            raise
        # Drain remaining work.
        while in_flight:
            _drain_one()

    return bytes_written, completed


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
    grid = geometry["chunk_grid"]

    # Persist geometry as the level metadata so the API can serve it.
    metadata = {
        "level": level,
        "max_dimension": RESOLUTION_LEVELS[level],
        "image_w": geometry["image_w"],
        "image_h": geometry["image_h"],
        "chunk_w": geometry["chunk_w"],
        "chunk_h": geometry["chunk_h"],
        "chunk_grid": grid,
        "scale": geometry["scale"],
        "width_blocks": geometry["width_blocks"],
        "height_blocks": geometry["height_blocks"],
        "start_x": geometry["start_x"],
        "start_z": geometry["start_z"],
    }

    # Figure out which chunks to render this run.
    #
    # Geometry-change guard: if the world bbox / scale / origin has shifted
    # since the last regen, every existing chunk's pixels correspond to a
    # different world region under the new metadata.json. Reusing them would
    # silently misalign the stitched map. In that case we promote the
    # request to a full regen even if a partial bbox was supplied.
    if affected_bounds is not None:
        try:
            prev_meta_raw = r2_storage.download_bytes(
                r2_storage.tops_map_level_metadata_key(level)
            )
            prev_meta = json.loads(prev_meta_raw.decode("utf-8"))
        except FileNotFoundError:
            prev_meta = None
        except Exception:
            logger.exception(
                "Level %s: could not read previous metadata.json; "
                "forcing full regen", level,
            )
            prev_meta = {}  # truthy + missing keys → mismatch → full regen

        if prev_meta is not None:
            geometry_keys = (
                "scale", "chunk_w", "chunk_h",
                "start_x", "start_z", "chunk_grid",
                "image_w", "image_h",
            )
            mismatched = [
                k for k in geometry_keys
                if prev_meta.get(k) != metadata.get(k)
            ]
            if mismatched:
                logger.warning(
                    "Level %s: geometry changed (%s); promoting partial regen "
                    "to full regen to avoid stale chunk misalignment",
                    level, ", ".join(mismatched),
                )
                affected_bounds = None

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
                    level, grid * grid)
        # Wipe orphaned chunks left over from a previous grid configuration.
        # If the grid shrank or grew, old objects at coords outside the new
        # grid would otherwise stay in R2 and (under a smaller new grid)
        # leak through the level prefix listing. Best-effort — a failure
        # here is logged but doesn't abort the regen.
        try:
            prefix = f"cache/tops-map-level{level}/"
            for key in r2_storage.list_keys_with_prefix(prefix):
                name = key[len(prefix):]
                if not name.startswith("chunk-") or not name.endswith(".png"):
                    continue
                try:
                    cx_str, cy_str = name[len("chunk-"):-len(".png")].split("-")
                    ocx, ocy = int(cx_str), int(cy_str)
                except (ValueError, IndexError):
                    continue
                if ocx >= grid or ocy >= grid:
                    try:
                        r2_storage.delete_object(key)
                        db.delete_chunk_url(level, ocx, ocy)
                    except Exception:
                        logger.exception(
                            "Failed to delete orphan chunk %s", key,
                        )
        except Exception:
            logger.exception("Orphan-chunk cleanup pass failed for level %s", level)

    chunks_to_render = list(iter_chunk_coords(grid, only_bounds))
    total_grid = grid * grid
    tracker.mark_started(level, total_chunks=total_grid)

    # Count already-existing chunks outside the regen window as completed.
    completed = 0
    bytes_written = 0
    if only_bounds is not None:
        completed = total_grid - len(chunks_to_render)
        tracker.update_progress(level, completed, current_chunk=None)

    if PARALLEL_REGEN and chunks_to_render:
        bytes_written, completed = _render_level_parallel(
            db_path, level, geometry, only_bounds,
            initial_completed=completed,
            total_grid=total_grid,
        )
    else:
        for cx, cy in chunks_to_render:
            if is_stop_requested():
                raise _StopRequested(
                    f"stopped at level {level} after {completed}/{total_grid} chunks"
                )
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


def _coalesce_queue_entries(
    rows: List[dict],
    configured_levels: List[int],
) -> Dict[int, Optional[Tuple[int, int, int, int]]]:
    """Collapse a batch of queue rows into a per-level work plan.

    Each row in ``rows`` is a dict from ``database.drain_regen_queue``. The
    output maps ``level -> bounds``, where ``bounds`` is either:
      * ``None`` — full regen of that level (some queued row demanded it)
      * ``(min_x, max_x, min_z, max_z)`` — union bbox of every partial regen
        request that targeted this level.

    Levels with no rows targeting them are absent from the returned dict.
    """
    plan: Dict[int, Optional[Tuple[int, int, int, int]]] = {}
    full_levels: set = set()

    for row in rows:
        raw_levels = row.get("levels")
        if raw_levels is None:
            target_levels = list(configured_levels)
        else:
            try:
                parsed = json.loads(raw_levels)
                target_levels = [int(l) for l in parsed if int(l) in configured_levels]
            except (json.JSONDecodeError, TypeError, ValueError):
                target_levels = list(configured_levels)

        is_full = bool(row.get("full_regen"))
        bbox = None
        if not is_full and row.get("min_x") is not None:
            bbox = (
                int(row["min_x"]), int(row["max_x"]),
                int(row["min_z"]), int(row["max_z"]),
            )
        # No bbox + not full_regen would be a malformed row → treat as full
        # to be safe (over-render rather than miss tiles).
        if bbox is None:
            is_full = True

        for lvl in target_levels:
            if is_full or lvl in full_levels:
                full_levels.add(lvl)
                plan[lvl] = None
                continue
            existing = plan.get(lvl, ...)
            if existing is None:  # already marked full by an earlier row
                continue
            if existing is ...:
                plan[lvl] = bbox
            else:
                # Union the two bounding boxes.
                ex = existing
                plan[lvl] = (
                    min(ex[0], bbox[0]),
                    max(ex[1], bbox[1]),
                    min(ex[2], bbox[2]),
                    max(ex[3], bbox[3]),
                )

    return plan


def _worker_loop():
    """Drain the regen queue and run one generation pass per drain.

    Continues looping as long as new work appears between passes, so
    contributions approved during a long-running render are still picked up
    in the same worker lifetime. Holds ``_job_lock`` only briefly at the
    "should I exit?" check, ensuring an enqueue that lands at the wrong
    moment is not lost: if the post-job drain returns rows, we run another
    pass; if it returns empty *while we hold the lock*, no new enqueue can
    sneak in before we clear ``_active_thread``.
    """
    global _active_thread
    configured_levels = sorted(RESOLUTION_LEVELS.keys())

    try:
        while True:
            if is_stop_requested():
                # Discard any rows still in the queue so we don't resume
                # immediately after the admin asked to stop. A subsequent
                # ``start_job`` call clears the stop flag and re-enqueues.
                try:
                    db.drain_regen_queue()
                except Exception:
                    logger.exception("Failed to drain regen queue while stopping")
                logger.info("Map generation worker exiting due to stop request")
                with _job_lock:
                    _active_thread = None
                return

            try:
                rows = db.drain_regen_queue()
            except Exception:
                logger.exception("Failed to drain regen queue; sleeping out worker")
                rows = []

            if not rows:
                # Recheck under the lock so a producer cannot race past us.
                with _job_lock:
                    try:
                        rows = db.drain_regen_queue()
                    except Exception:
                        logger.exception("Failed to drain regen queue (locked)")
                        rows = []
                    if not rows:
                        _active_thread = None
                        return

            plan = _coalesce_queue_entries(rows, configured_levels)
            if not plan:
                continue

            db_path: Optional[str] = None
            try:
                db_path = _snapshot_combined_db()
                stopped = False
                for lvl in sorted(plan.keys()):
                    if stopped:
                        # Mark levels we never got to as failed too so the
                        # UI doesn't show them stuck mid-job.
                        try:
                            tracker.mark_failed(lvl, "Stopped by admin (skipped)")
                        except Exception:
                            pass
                        continue
                    bounds = plan[lvl]
                    try:
                        _generate_level(db_path, lvl, affected_bounds=bounds)
                    except _StopRequested as stop_exc:
                        stopped = True
                        try:
                            tracker.mark_failed(lvl, f"Stopped by admin ({stop_exc})")
                        except Exception:
                            pass
                        logger.info("Level %s aborted: %s", lvl, stop_exc)
                    except Exception as exc:
                        tracker.mark_failed(lvl, str(exc))
                        logger.exception("Level %s generation failed", lvl)
                        # Continue with remaining levels.
                if stopped:
                    # Discard the rest of the queue and exit cleanly so a
                    # follow-up ``start_job`` is needed to resume work.
                    try:
                        db.drain_regen_queue()
                    except Exception:
                        logger.exception("Failed to drain regen queue after stop")
                    with _job_lock:
                        _active_thread = None
                    return
            except Exception as exc:
                logger.exception("Map generation pass aborted: %s", exc)
                for lvl in plan:
                    try:
                        tracker.mark_failed(lvl, str(exc))
                    except Exception:
                        pass
            finally:
                # ``db_path`` is a worker-private snapshot of the shared
                # combined.db cache (see :func:`_snapshot_combined_db`).
                # Always delete it after the pass so old snapshots don't
                # accumulate on the persistent disk.
                if db_path and os.path.exists(db_path):
                    try:
                        os.unlink(db_path)
                    except OSError:
                        logger.exception(
                            "Failed to delete regen DB snapshot %s", db_path
                        )
    finally:
        # Defensive: never leave _active_thread pointing at a finished thread.
        with _job_lock:
            if _active_thread is not None and not _active_thread.is_alive():
                _active_thread = None


def start_job(levels: Optional[List[int]] = None,
              affected_bounds: Optional[Tuple[int, int, int, int]] = None) -> bool:
    """Enqueue a regeneration request and ensure the worker is running.

    Always succeeds in recording the request (returns True), regardless of
    whether the worker had to be spawned or one was already running. The
    boolean return value is preserved for backward compatibility with callers
    that previously used it as "did we launch a worker?" — its semantics are
    now "is there a worker that will pick this request up?".

    ``levels=None`` means "all configured levels". ``affected_bounds=None``
    means "full regen of those levels". Both default to the broadest possible
    request so a caller who omits everything triggers a full regen of every
    level.
    """
    global _active_thread

    if levels is None:
        request_levels: Optional[List[int]] = None
    else:
        request_levels = [lvl for lvl in levels if lvl in RESOLUTION_LEVELS]
        if not request_levels:
            return False

    try:
        db.enqueue_regen(affected_bounds, request_levels)
    except Exception:
        logger.exception("Failed to enqueue regen request")
        return False

    # Heavy-compute kill switch. The request stays in regen_queue so it will
    # be picked up by the next ``resume_pending_work`` / poller tick once
    # the flag is flipped back on; we just don't spawn a worker right now.
    try:
        from ..core.feature_flags import is_heavy_compute_allowed
        if not is_heavy_compute_allowed():
            logger.info(
                "generate_map_levels: skipping spawn — heavy_compute_enabled is OFF "
                "(request enqueued and will resume when the flag is re-enabled)"
            )
            return True
    except Exception:
        logger.exception("generate_map_levels: feature-flag check failed")

    with _job_lock:
        # A new explicit start request always clears any prior stop flag —
        # otherwise the worker we're about to spawn would exit immediately.
        clear_stop()
        if is_job_running():
            return True
        thread = threading.Thread(
            target=_worker_loop,
            name="tops-map-generator",
            daemon=True,
        )
        _active_thread = thread
        thread.start()
        return True


def resume_pending_work():
    """Start the worker if the queue has rows but no worker is alive.

    Intended to be called once at FastAPI startup so a process restart
    mid-pass does not strand previously-enqueued requests.

    Also recovers from a process that died *mid-render*: ``drain_regen_queue``
    deletes its rows before rendering begins, so a crash after that point
    leaves the queue empty but the level pinned at ``status='generating'``
    in the tracker forever, with stale chunks served alongside fresh ones.
    For each such level we reset the tracker entry and enqueue a full regen
    so the next worker pass re-renders it cleanly.
    """
    global _active_thread

    # Step 1 — recover orphaned 'generating' levels.
    #
    # Skip this scan entirely when a worker is alive in *this* process: any
    # 'generating' entries belong to it, not to a dead predecessor. Without
    # this guard the periodic heavy_compute_poller tick (every ~30s) would
    # see the in-flight level as orphaned, reset its tracker, and enqueue a
    # redundant full regen — producing an infinite "left in 'generating'
    # state by previous process" warning loop.
    if is_job_running():
        return

    try:
        status = tracker.get_status()
        orphaned: List[int] = []
        for key, entry in (status.get("levels") or {}).items():
            if entry.get("status") == "generating":
                try:
                    orphaned.append(int(key))
                except (TypeError, ValueError):
                    continue
        for lvl in orphaned:
            if lvl not in RESOLUTION_LEVELS:
                continue
            logger.warning(
                "Level %s left in 'generating' state by previous process; "
                "resetting tracker and re-enqueuing full regen.", lvl,
            )
            try:
                tracker.reset_level(lvl)
            except Exception:
                logger.exception("Could not reset tracker for level %s", lvl)
            try:
                db.enqueue_regen(None, [lvl])
            except Exception:
                logger.exception("Could not enqueue recovery regen for level %s", lvl)
    except Exception:
        logger.exception("Could not scan tracker for orphaned 'generating' levels")

    # Step 2 — start the worker if anything is queued (recovery rows above
    # plus anything that survived the restart in regen_queue).
    try:
        size = db.regen_queue_size()
    except Exception:
        logger.exception("Could not check regen queue at startup")
        return
    if size <= 0:
        return

    # Heavy-compute kill switch — leave the queue rows alone so a later
    # flag-flip / poller tick resumes them; just don't spawn now.
    try:
        from ..core.feature_flags import is_heavy_compute_allowed
        if not is_heavy_compute_allowed():
            logger.info(
                "generate_map_levels: %d queued row(s) but heavy_compute_enabled "
                "is OFF; deferring worker spawn", size,
            )
            return
    except Exception:
        logger.exception("generate_map_levels: feature-flag check failed")

    with _job_lock:
        if is_job_running():
            return
        thread = threading.Thread(
            target=_worker_loop,
            name="tops-map-generator",
            daemon=True,
        )
        _active_thread = thread
        thread.start()

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
                db_path = _download_combined_db()
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
            # Note: ``db_path`` is the shared cached combined.db; do NOT
            # delete it here. The cache is invalidated when something
            # uploads a new combined.db (approval merge, admin restore).
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

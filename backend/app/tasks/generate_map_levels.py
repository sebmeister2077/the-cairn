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
import queue
import shutil
import sqlite3
import tempfile
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from ..core import r2_storage
from ..core import generation_tracker as tracker
from ..core import database as db
from ..core import upload_dedup
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

# ---------------------------------------------------------------------------
# Tier 6 (May 2026) — dedicated regen file logger.
#
# Console output is dominated by HTTP access lines, which makes it hard to
# eyeball the regen sequence. Tee everything this module logs to
# ``backend/logs/regen.log`` (rotating) so you can ``Get-Content -Wait`` it
# in a side terminal and see *only* regen events.
# ---------------------------------------------------------------------------

def _install_regen_file_logger() -> None:
    try:
        from logging.handlers import RotatingFileHandler
        log_dir = os.environ.get("TOPS_MAP_LOG_DIR") or os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
            "logs",
        )
        os.makedirs(log_dir, exist_ok=True)
        log_path = os.path.join(log_dir, "regen.log")
        # Avoid double-attaching on uvicorn --reload.
        for h in logger.handlers:
            if isinstance(h, RotatingFileHandler) and \
                    getattr(h, "baseFilename", "") == os.path.abspath(log_path):
                return
        handler = RotatingFileHandler(
            log_path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8",
        )
        handler.setLevel(logging.INFO)
        handler.setFormatter(logging.Formatter(
            "%(asctime)s [%(levelname)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        ))
        # Only emit records that came from this module / its helpers, so
        # the file isn't polluted by unrelated uvicorn.error logs.
        _allowed_modules = {
            "generate_map_levels", "upload_dedup", "mapdb", "mapdb_cache",
        }

        class _RegenFilter(logging.Filter):
            def filter(self, record: logging.LogRecord) -> bool:
                return record.module in _allowed_modules

        handler.addFilter(_RegenFilter())
        logger.addHandler(handler)
        logger.info("Regen file logger attached: %s", log_path)
    except Exception:
        # Best-effort — never let logging setup break the worker.
        pass


_install_regen_file_logger()

# Tier 5 (May 2026) — process-wide content-hash skip cache for R2 PUTs.
# Populated by ``_snapshot_combined_db`` (keyed to the canonical combined.db
# path so it survives across regen snapshots) and consumed by
# ``_encode_and_upload_chunk``. ``_dedup_lock`` guards the shared sqlite
# conn so the encode/upload threadpool can share it safely.
_dedup_conn = None  # type: Optional["sqlite3.Connection"]
_dedup_lock = threading.Lock()
# Tier 6 (May 2026) — canonical combined.db mtime captured at the start of
# each regen pass. Used as the cache key for whole-level skip.
_canonical_src_mtime: Optional[float] = None


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
#
# Tier 4.1 (May 2026): default flipped from False → True. The parallel
# pipeline has been stable in production for the last regen cycles and is
# 2–4× faster than the sequential path on the worker boxes. To opt back out
# (e.g. while debugging a regression) set ``TOPS_MAP_PARALLEL_REGEN=0`` in
# the worker env.
PARALLEL_REGEN = _env_bool("TOPS_MAP_PARALLEL_REGEN", default=True)

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

# Tier 7 (May 2026) — multi-band producers.
#
# Previously a single thread ran ``render_level_streaming`` and fed the
# encode/upload pool. With 11 workers the pool was starved (CPU ~18%):
# the producer's per-tile paste loop is Python-bound (holds the GIL) and
# its SQLite reads stall on disk during sidecar-cache misses, so the
# encode/upload threads spent most of their time waiting.
#
# We now split the chunk-row range into ``PARALLEL_REGEN_BANDS`` disjoint
# horizontal bands and run one producer thread per band. Each producer
# opens its own read-only SQLite connection (``mode=ro&immutable=1``,
# lock-free, mmap-backed — see ``_open_mapdb_readonly``) and pushes
# ``(cx, cy, arr)`` tuples into a bounded queue. The main thread drains
# the queue and submits to the existing encode/upload executor.
#
# Threads can't escape the GIL during the Python-level paste loop, so
# ideal scaling is sub-linear; in practice 3-4 bands fully feeds an
# 8-16 worker pool. Set ``TOPS_MAP_PARALLEL_REGEN_BANDS=1`` to revert to
# the single-producer behaviour while debugging.
PARALLEL_REGEN_BANDS = max(
    1,
    min(
        int(os.environ.get("TOPS_MAP_PARALLEL_REGEN_BANDS", "0") or 0)
        or min(4, max(1, (os.cpu_count() or 2) // 2)),
        16,
    ),
)

print(f"TOPS map regen: parallel={PARALLEL_REGEN} workers={PARALLEL_REGEN_WORKERS} bands={PARALLEL_REGEN_BANDS}")

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
    # Tier 5 (May 2026): swap in a dedup conn keyed to the canonical
    # combined.db path. Persists across snapshots so a second full regen
    # of unchanged data can skip every R2 PUT. Worker threads share this
    # via the module-level lock.
    global _dedup_conn, _canonical_src_mtime
    try:
        old = _dedup_conn
        _dedup_conn = upload_dedup.open_dedup(src)
        if _dedup_conn is not None:
            logger.info(
                "Upload dedup cache armed: %s (%d entries known)",
                upload_dedup.dedup_path_for(src),
                upload_dedup.row_count(_dedup_conn),
            )
        else:
            logger.info(
                "Upload dedup cache disabled or unavailable for %s — "
                "every chunk will be re-uploaded to R2", src,
            )
        if old is not None and old is not _dedup_conn:
            upload_dedup.close(old)
    except Exception:
        logger.exception("upload_dedup: open failed (non-fatal)")
    # Tier 6 (May 2026): capture canonical mtime for whole-level skip.
    try:
        _canonical_src_mtime = os.path.getmtime(src)
        logger.info(
            "Canonical combined.db mtime captured: %.3f (%s)",
            _canonical_src_mtime, src,
        )
    except OSError:
        _canonical_src_mtime = None
        logger.warning("Could not stat canonical combined.db at %s", src)
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

    # Tier 3.2 (May 2026): if a sidecar RGBA cache exists next to the
    # shared cached combined.db, hardlink (or copy as fallback) it to
    # ``<snap_path>.cache.db`` so the render hot path sees a fresh cache
    # for the snapshot. Without this, every regen pass would silently
    # fall back to the canonical varint decode because the cache is
    # keyed on the source DB path.
    try:
        from ..core.mapdb_cache import cache_path_for
        src_cache = cache_path_for(src)
        snap_cache = cache_path_for(snap_path)
        if os.path.isfile(src_cache):
            try:
                os.link(src_cache, snap_cache)  # hardlink — zero IO/space
            except OSError:
                shutil.copyfile(src_cache, snap_cache)
            # Match snapshot mtime to its cache so the freshness check
            # passes (``cache_mtime >= src_mtime``).
            src_mtime = os.path.getmtime(snap_path)
            try:
                os.utime(snap_cache, (src_mtime, src_mtime))
            except OSError:
                pass
            logger.info(
                "Sidecar RGBA cache linked for regen snapshot: %s (%.1f MiB)",
                snap_cache, os.path.getsize(snap_cache) / (1024 * 1024),
            )
        else:
            logger.info(
                "No sidecar RGBA cache at %s — regen will use the canonical "
                "varint decode. Run `python backend/build_mapdb_cache.py %s` "
                "once to enable the Tier 3.2 fast render path (~2x speedup).",
                src_cache, src,
            )
    except Exception:
        logger.exception("sidecar cache link failed for regen snapshot (non-fatal)")

    return snap_path


def write_level_pointer(level: int, *, live: Optional[str], previous: Optional[str]) -> None:
    """Write ``cache/tops-map-level{level}/CURRENT.json`` describing which
    versioned subprefix is currently live (and which one is kept around for
    rollback). Pass ``None`` for the legacy unprefixed layout.
    """
    payload = {"live": live, "previous": previous}
    r2_storage.upload_bytes(
        r2_storage.tops_map_level_pointer_key(level),
        json.dumps(payload).encode("utf-8"),
        content_type="application/json",
    )


def delete_version_objects(level: int, version: Optional[str]) -> int:
    """Best-effort delete of every R2 object under a given staged version
    subprefix. Returns the number of keys deleted. ``None`` and the legacy
    sentinel are ignored to avoid wiping the legacy bundle by accident.
    """
    if not version or version == r2_storage.TOPS_MAP_LEGACY_VERSION:
        return 0
    prefix = (
        f"cache/tops-map-level{level}/"
        f"{r2_storage._tops_map_version_subpath(version)}"
    )
    try:
        keys = r2_storage.list_keys_with_prefix(prefix)
    except Exception:
        logger.exception("delete_version_objects: list failed for %s", prefix)
        return 0
    if not keys:
        return 0
    try:
        r2_storage.delete_keys(keys)
    except Exception:
        logger.exception(
            "delete_version_objects: bulk delete failed for %s (%d keys)",
            prefix, len(keys),
        )
        return 0
    return len(keys)


def activate_pending_version(level: int) -> dict:
    """Promote a level's pending staged version to live. The previous live
    version is retained as the new ``previous`` so an admin can roll back.
    Any version that was previously sitting in the ``previous`` slot is
    deleted from R2 (we keep at most one rollback target per level).

    Raises ``RuntimeError`` if no pending version exists. Caller is
    responsible for refusing the call while ``is_job_running()``.

    Returns ``{\"live\": ..., \"previous\": ..., \"discarded\": ...}``.
    """
    if level not in RESOLUTION_LEVELS:
        raise RuntimeError(f"Unknown level: {level}")
    pending = tracker.get_pending_version(level)
    if not pending:
        raise RuntimeError(f"Level {level} has no pending version to activate")
    old_live = tracker.get_live_version(level)
    old_previous = tracker.get_previous_version(level)

    # Flip the pointer first \u2014 if this fails the tracker stays in
    # ``pending_activation`` and the admin can retry.
    write_level_pointer(level, live=pending, previous=old_live)
    tracker.activate_pending(level)

    # Invalidate caches so the next request sees the new pointer + metadata.
    try:
        from ..routes import tops_map_r2 as _tops_map_r2
        _tops_map_r2.invalidate_level_pointer_cache(level)
    except Exception:
        pass
    try:
        db.delete_chunk_urls_for_level(level)
    except Exception:
        logger.exception(
            "activate_pending_version: failed to flush chunk URL cache for level %s",
            level,
        )

    # Garbage-collect the version that just fell off the rollback slot.
    # We only keep ONE previous bundle per level.
    discarded = None
    if old_previous and old_previous != old_live and old_previous != pending:
        deleted = delete_version_objects(level, old_previous)
        if deleted:
            discarded = {"version": old_previous, "deleted_keys": deleted}

    # Note: Tier 6 level-skip dedup is NOT recorded here. It was skipped
    # at end-of-render for staged regens because we didn't yet know if/when
    # the bundle would go live. Re-recording would require trusting that
    # the source combined.db hasn't changed since staging, which we cannot
    # verify at activation time. The next full regen against the same
    # canonical mtime will simply do the work again \u2014 acceptable cost
    # for guaranteed correctness.

    return {
        "live": pending,
        "previous": old_live,
        "discarded": discarded,
    }


def rollback_to_previous_version(level: int) -> dict:
    """Restore the previous live version of a level. The bundle that was
    live becomes the new ``previous`` (so the rollback itself can be
    rolled back). Any pending staged version is left in place \u2014 admins
    must explicitly discard it via the delete-level endpoint if they
    want it gone.

    Raises ``RuntimeError`` if no previous version exists.
    """
    if level not in RESOLUTION_LEVELS:
        raise RuntimeError(f"Unknown level: {level}")
    previous = tracker.get_previous_version(level)
    if not previous:
        raise RuntimeError(f"Level {level} has no previous version to roll back to")
    old_live = tracker.get_live_version(level)

    write_level_pointer(level, live=previous, previous=old_live)
    tracker.rollback_to_previous(level)

    try:
        from ..routes import tops_map_r2 as _tops_map_r2
        _tops_map_r2.invalidate_level_pointer_cache(level)
    except Exception:
        pass
    try:
        db.delete_chunk_urls_for_level(level)
    except Exception:
        logger.exception(
            "rollback_to_previous_version: failed to flush chunk URL cache for level %s",
            level,
        )

    return {"live": previous, "previous": old_live}


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
            live_version = tracker.get_live_version(level)
            try:
                prev_raw = r2_storage.download_bytes(
                    r2_storage.tops_map_level_metadata_key(level, version=live_version)
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
                    r2_storage.tops_map_level_metadata_key(level, version=live_version),
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
            # Tier 3.2 (May 2026): drop the snapshot-local sidecar too.
            for orphan in (snap_path + ".cache.db",):
                try:
                    os.unlink(orphan)
                except OSError:
                    pass

    return refreshed


def _encode_and_upload_chunk(
    level: int,
    cx: int,
    cy: int,
    arr,  # Optional[np.ndarray]
    *,
    version: Optional[str] = None,
    invalidate_url_cache: bool = True,
) -> int:
    """Worker-thread task: PNG-encode one chunk's RGBA buffer and upload it
    to R2. For empty/transparent chunks, deletes any pre-existing object so
    the cache reflects the new state. Returns the number of bytes written
    (0 for empty chunks).

    ``version`` selects which bundle this upload belongs to. ``None`` /
    :data:`r2_storage.TOPS_MAP_LEGACY_VERSION` writes to the legacy bare
    prefix; any other value writes under the corresponding subdirectory
    so a staged full regen never disturbs the live keys.

    ``invalidate_url_cache`` should be left ``True`` only when the upload
    target IS the currently live version (so cached presigned URLs are
    stale). Staged uploads pass ``False`` because the URL table only ever
    holds URLs for the live bundle.

    Both Pillow's PNG encoder and boto3's HTTPS upload release the GIL for
    the bulk of their work, so calling this from many threads in parallel
    yields real speedup.
    """
    chunk_key = r2_storage.tops_map_level_chunk_key(level, cx, cy, version=version)
    png = encode_chunk_array_to_png(arr)

    # Tier 5 (May 2026) — content-hash dedup. If the chunk's PNG bytes
    # hash to the same value we last uploaded to R2 for (level, cx, cy),
    # skip the PUT/DELETE entirely. ``new_hash=None`` means "this chunk
    # is empty"; we record that as a NULL row so a subsequent regen that
    # produces another empty chunk skips the DELETE too.
    #
    # Staged-swap caveat: the dedup table is keyed by (level, cx, cy) and
    # therefore implicitly tracks ONE bundle per level. Skipping a PUT to
    # a staging version because the live version already has matching
    # content would leave the staging prefix incomplete and produce a
    # corrupted bundle on activation. Disable dedup whenever the target
    # is not the live version.
    use_dedup = version is None or version == r2_storage.TOPS_MAP_LEGACY_VERSION
    new_hash = upload_dedup.hash_png(png) if use_dedup else None
    if use_dedup and upload_dedup.should_skip_upload(
        _dedup_conn, _dedup_lock, level, cx, cy, new_hash,
    ):
        # R2 already has this exact content (or the known-empty marker).
        # Return the byte count for the size accounting so the metadata
        # totals stay consistent with the rendered output.
        return len(png) if png is not None else 0

    if png is None:
        try:
            r2_storage.delete_object(chunk_key)
        except Exception:
            pass
        if invalidate_url_cache:
            try:
                db.delete_chunk_url(level, cx, cy)
            except Exception:
                pass
        if use_dedup:
            upload_dedup.record(_dedup_conn, _dedup_lock, level, cx, cy, None)
        return 0
    r2_storage.upload_bytes(chunk_key, png, content_type="image/png")
    if invalidate_url_cache:
        try:
            db.delete_chunk_url(level, cx, cy)
        except Exception:
            pass
    if use_dedup:
        upload_dedup.record(_dedup_conn, _dedup_lock, level, cx, cy, new_hash)
    return len(png)


def _render_level_parallel(
    db_path: str,
    level: int,
    geometry: dict,
    only_bounds: Optional[Tuple[int, int, int, int]],
    initial_completed: int,
    total_grid: int,
    *,
    target_version: Optional[str] = None,
    invalidate_url_cache: bool = True,
) -> Tuple[int, int]:
    """Parallel render path: streams chunk RGBA buffers from one SQLite scan
    per chunk-row and fans encode+upload out to a thread pool.

    Tier 7 (May 2026): the producer side is now multi-banded. The chunk-row
    range is split into ``PARALLEL_REGEN_BANDS`` horizontal bands; one
    producer thread per band runs :func:`render_level_streaming` and pushes
    ``(cx, cy, arr)`` tuples into a bounded queue. The main thread drains
    the queue and submits to the encode/upload executor. Each producer
    opens its own read-only SQLite connection (mmap-backed, lock-free) so
    scans run truly concurrently and the encode pool stays fed.

    Returns ``(bytes_written, completed)``. Honours :func:`is_stop_requested`
    between submissions and raises :class:`_StopRequested` if signaled.
    """
    grid = geometry["chunk_grid"]
    if only_bounds is None:
        full_bounds: Tuple[int, int, int, int] = (0, 0, grid - 1, grid - 1)
    else:
        full_bounds = only_bounds
    cx_min, cy_min, cx_max, cy_max = full_bounds

    bytes_written = 0
    completed = initial_completed
    workers = PARALLEL_REGEN_WORKERS

    # Split cy range into bands. Cap band count at the number of available
    # rows so we don't spawn empty producers.
    total_rows = max(0, cy_max - cy_min + 1)
    if total_rows == 0:
        return 0, initial_completed
    band_count = max(1, min(PARALLEL_REGEN_BANDS, total_rows))
    band_size = (total_rows + band_count - 1) // band_count  # ceil
    band_ranges: List[Tuple[int, int, int, int]] = []
    for i in range(band_count):
        b_lo = cy_min + i * band_size
        if b_lo > cy_max:
            break
        b_hi = min(cy_max, b_lo + band_size - 1)
        band_ranges.append((cx_min, b_lo, cx_max, b_hi))

    # Cap in-flight encode/upload tasks so a slow R2 doesn't let producers
    # outrun the pool and balloon memory with queued PNG buffers.
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

    # Bounded producer→consumer queue. Sized to keep the encode pool fed
    # without holding too many RGBA buffers in memory: each producer can
    # have ~2 chunks queued, plus enough slack for the main thread to keep
    # the executor topped up.
    chunk_queue: "queue.Queue[Optional[Tuple[int, int, Optional[object]]]]" = (
        queue.Queue(maxsize=max(workers * 2, len(band_ranges) * 2))
    )

    # Signal producers to bail out (e.g. on stop request or encode failure).
    abort_event = threading.Event()
    producer_errors: List[BaseException] = []
    producer_errors_lock = threading.Lock()

    def _producer(band_bounds: Tuple[int, int, int, int]) -> None:
        try:
            for cx, cy, arr in render_level_streaming(
                db_path, level, geometry, band_bounds,
            ):
                if abort_event.is_set() or is_stop_requested():
                    return
                # ``put`` blocks on backpressure — this is what naturally
                # rate-limits producers to whatever the encode pool drains.
                while True:
                    try:
                        chunk_queue.put((cx, cy, arr), timeout=0.5)
                        break
                    except queue.Full:
                        if abort_event.is_set() or is_stop_requested():
                            return
        except BaseException as e:  # noqa: BLE001 — re-raised on main thread
            with producer_errors_lock:
                producer_errors.append(e)
            abort_event.set()

    producer_threads = [
        threading.Thread(
            target=_producer,
            args=(bb,),
            name=f"tops-map-l{level}-prod{i}",
            daemon=True,
        )
        for i, bb in enumerate(band_ranges)
    ]

    # Watcher: when every producer exits, push a sentinel so the consumer
    # loop unblocks on the final ``get``.
    def _watch_producers() -> None:
        for t in producer_threads:
            t.join()
        try:
            chunk_queue.put(None, timeout=1.0)
        except queue.Full:
            # Consumer already aborted; nothing to wake up.
            pass

    watcher = threading.Thread(
        target=_watch_producers,
        name=f"tops-map-l{level}-watch",
        daemon=True,
    )

    logger.info(
        "Level %s: parallel regen path enabled "
        "(workers=%s, bands=%s, row-stripe scan per band)",
        level, workers, len(band_ranges),
    )

    with ThreadPoolExecutor(
        max_workers=workers,
        thread_name_prefix=f"tops-map-l{level}",
    ) as executor:
        for t in producer_threads:
            t.start()
        watcher.start()
        try:
            try:
                while True:
                    item = chunk_queue.get()
                    if item is None:
                        break
                    cx, cy, arr = item
                    if is_stop_requested():
                        abort_event.set()
                        raise _StopRequested(
                            f"stopped at level {level} after "
                            f"{completed}/{total_grid} chunks"
                        )
                    fut = executor.submit(
                        _encode_and_upload_chunk, level, cx, cy, arr,
                        version=target_version,
                        invalidate_url_cache=invalidate_url_cache,
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
            except BaseException:
                abort_event.set()
                raise
            # Drain remaining work.
            while in_flight:
                _drain_one()
        finally:
            # Tier 7 hotfix: producers and watcher MUST be joined before we
            # leave this function. They hold per-band read-only SQLite
            # connections on ``db_path``; on Windows an open handle blocks
            # the caller's ``os.unlink(db_path)`` cleanup with WinError 32.
            # ``abort_event`` makes mid-scan producers exit promptly; we
            # also drain the queue so any producer blocked on ``put`` can
            # observe the abort flag on its next retry.
            abort_event.set()
            while True:
                try:
                    chunk_queue.get_nowait()
                except queue.Empty:
                    break
            for t in producer_threads:
                t.join(timeout=10.0)
                if t.is_alive():
                    logger.warning(
                        "Level %s producer %s did not exit within 10s; "
                        "snapshot DB may not be deletable on Windows.",
                        level, t.name,
                    )
            watcher.join(timeout=5.0)

    # Surface any producer-side error that didn't already abort us via the
    # queue path (e.g. an exception raised after the sentinel was queued).
    with producer_errors_lock:
        if producer_errors:
            raise producer_errors[0]

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

    Staged-swap policy (May 2026)
    -----------------------------
    * **Full regen** (``affected_bounds is None``) writes every chunk and
      ``metadata.json`` under a brand-new version subprefix
      (``cache/tops-map-level{N}/v-<ts>/``). The level's live R2 keys are
      untouched so users keep seeing the previous bundle while the staged
      version uploads. After completion the tracker records
      ``pending_version`` instead of marking ``complete`` so an admin
      must click "Activate" before the new bundle goes live.
    * **Partial regen** (bbox supplied) keeps the legacy in-place behaviour:
      it overwrites chunks inside ``affected_bounds`` on the LIVE version
      so contribution edits become visible immediately. Anything outside
      the bbox is reused from the existing live bundle.
    """
    # WAL-checkpoint guard. Every read connection opened by the regen
    # path uses ``mode=ro&immutable=1`` (see ``_open_mapdb_readonly``),
    # which makes SQLite skip the ``-wal`` file entirely and read only
    # pages out of the main DB file. If a contribution merge (or any
    # other writer) left pages uncheckpointed in ``combined.db-wal``,
    # those tile rows are INVISIBLE to immutable readers — the SELECT
    # silently returns nothing for those positions and the renderer
    # leaves the destination pixels transparent. At scale > 1 the
    # missing tiles get subsampled away into surrounding ones and the
    # corruption is easy to overlook; at scale=1 (level 5) every
    # missing tile is a visible 32×32 px hole, which is exactly the
    # "stale chunks at the boundary" symptom reported in May 2026.
    #
    # Force a full WAL→main checkpoint here so every subsequent
    # immutable read sees a complete snapshot. TRUNCATE leaves the WAL
    # file zero-sized, which is also cheaper for the immutable opener.
    # If the DB isn't in WAL mode (e.g. a writer never ran) the pragma
    # is a no-op.
    try:
        ckpt_conn = sqlite3.connect(db_path, timeout=30.0)
        try:
            ckpt_conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            ckpt_conn.close()
    except Exception:
        logger.exception(
            "Level %s: WAL checkpoint before regen failed (continuing; "
            "may render stale tiles if combined.db-wal has uncheckpointed "
            "pages)", level,
        )

    geometry = compute_level_geometry(db_path, level)
    grid = geometry["chunk_grid"]

    is_full_regen = affected_bounds is None
    live_version = tracker.get_live_version(level)  # None / "__legacy__" / "v-..."
    if is_full_regen:
        # Stamp this regen with a fresh version id so it's addressable
        # independently from whatever's currently live. Seconds precision
        # plus the pid is enough to disambiguate same-second restarts
        # without dragging in uuid.
        target_version = "v-" + datetime.now(timezone.utc).strftime(
            "%Y%m%d-%H%M%S"
        ) + f"-{os.getpid()}"
        invalidate_url_cache = False  # staged uploads never touch live URLs
        logger.info(
            "Level %s: full regen — staging to version %s (live=%s, won't "
            "be served until admin activates)",
            level, target_version, live_version or "__legacy__",
        )
    else:
        target_version = live_version  # write in-place to live bundle
        invalidate_url_cache = True
        pending = tracker.get_pending_version(level)
        if pending:
            logger.warning(
                "Level %s: partial regen applied to LIVE bundle, but a "
                "pending staged version %s is waiting for activation. "
                "Activating that pending version will overwrite the partial "
                "changes you're about to make.",
                level, pending,
            )

    # Tier 6 (May 2026) \u2014 whole-level skip.
    #
    # When a previous full regen recorded a (level, source_mtime) pair and
    # the canonical combined.db hasn't been touched since, the entire
    # level is byte-for-byte identical to what's already in R2. Bail out
    # before render, encode, hashing, and PUT \u2014 the most expensive parts
    # of the pass. Partial regens (affected_bounds set) never skip
    # because the bounds imply localized work the cache can't cover.
    if affected_bounds is None and _canonical_src_mtime is not None:
        try:
            cached_size = upload_dedup.can_skip_level(
                _dedup_conn, _dedup_lock, level, _canonical_src_mtime,
            )
        except Exception:
            logger.exception(
                "Level %s: dedup level-skip lookup failed; falling through "
                "to full regen", level,
            )
            cached_size = None
        if cached_size is not None:
            total_grid = grid * grid
            # Don't accidentally clobber a pending staged version by
            # flipping the tracker back to ``complete`` — the pending
            # bundle is still waiting for an admin click and the live
            # bundle is unchanged (source mtime hasn't moved).
            if tracker.get_pending_version(level):
                logger.info(
                    "Level %s: SKIPPED full regen (combined.db mtime unchanged); "
                    "keeping pending staged version untouched.", level,
                )
                return
            logger.info(
                "Level %s: SKIPPED entire level (combined.db mtime unchanged "
                "since last successful regen; reusing %d bytes across %d chunks)",
                level, cached_size, total_grid,
            )
            tracker.mark_started(level, total_chunks=total_grid)
            tracker.update_progress(level, total_grid, current_chunk=None)
            tracker.mark_complete(level, size_bytes=cached_size)
            return

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
                r2_storage.tops_map_level_metadata_key(level, version=live_version)
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
                # Tier 6: geometry change invalidates the skip marker —
                # any cached size_bytes refers to the old grid shape.
                try:
                    upload_dedup.invalidate_level(_dedup_conn, _dedup_lock, level)
                except Exception:
                    pass

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
        # Wipe orphaned chunks left over from a previous grid configuration
        # of THIS version's prefix. Since ``target_version`` is brand-new
        # for a staged full regen this prefix should be empty (so the loop
        # is a no-op); the cleanup still matters for the very first regen
        # under the legacy unprefixed layout (or if an aborted prior staged
        # run left partial files behind under the same version id, which
        # only happens within a single second of pid reuse).
        try:
            prefix = (
                f"cache/tops-map-level{level}/"
                f"{r2_storage._tops_map_version_subpath(target_version)}"
            )
            for key in r2_storage.list_keys_with_prefix(prefix):
                name = key[len(prefix):]
                # Skip subdirectory entries (other versions live in sibling
                # subprefixes that share the level prefix).
                if "/" in name:
                    continue
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
                        if invalidate_url_cache:
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
            target_version=target_version,
            invalidate_url_cache=invalidate_url_cache,
        )
    else:
        for cx, cy in chunks_to_render:
            if is_stop_requested():
                raise _StopRequested(
                    f"stopped at level {level} after {completed}/{total_grid} chunks"
                )
            try:
                chunk_png = render_chunk_png(db_path, level, cx, cy, geometry=geometry)
                chunk_key = r2_storage.tops_map_level_chunk_key(
                    level, cx, cy, version=target_version,
                )
                if chunk_png is None:
                    # Fully transparent — don't store it. Drop any pre-existing
                    # object + cached presigned URL so a re-generation can erase
                    # data from a previous run cleanly.
                    try:
                        r2_storage.delete_object(chunk_key)
                    except Exception:
                        pass
                    if invalidate_url_cache:
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
                    if invalidate_url_cache:
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
    # Only do this when the upload targeted the LIVE bundle — for a staged
    # full regen the live bundle (and its legacy assembled PNG sibling, if
    # any) must remain untouched until the admin activates.
    if invalidate_url_cache:
        try:
            r2_storage.delete_object(r2_storage.tops_map_level_assembled_key(level))
        except Exception:
            pass

    metadata["size_bytes"] = bytes_written
    r2_storage.upload_bytes(
        r2_storage.tops_map_level_metadata_key(level, version=target_version),
        json.dumps(metadata).encode("utf-8"),
        content_type="application/json",
    )

    # Drop the in-process metadata/pointer caches so the API serves the new
    # geometry immediately instead of the stale cached copy. Only the live
    # bundle's metadata is served, so a staged regen doesn't need this — but
    # the cache key is per-level so an extra invalidation is harmless.
    try:
        from ..routes import tops_map_r2 as _tops_map_r2
        _tops_map_r2.invalidate_level_metadata_cache(level)
    except Exception:
        pass

    if is_full_regen and target_version and target_version != live_version:
        # Staged regen: tracker holds the bundle aside until admin clicks
        # Activate. The live bundle and its presigned-URL cache are
        # untouched, so users keep seeing the previous map without any
        # half-uploaded chunks bleeding through.
        tracker.mark_pending_activation(
            level, target_version, size_bytes=bytes_written,
        )
        logger.info(
            "Level %s staged: %s bytes across %s chunks under version %s "
            "(awaiting admin activation)",
            level, bytes_written, total_grid, target_version,
        )
    else:
        tracker.mark_complete(level, size_bytes=bytes_written)
        logger.info(
            "Level %s complete: %s bytes across %s chunks (version=%s)",
            level, bytes_written, total_grid, target_version or "__legacy__",
        )

    # Tier 6 (May 2026) — record successful full-level regen so the next
    # pass against the same canonical combined.db can skip wholesale.
    # Partial regens do NOT record: they only refresh a sub-rect, so the
    # rest of the level may not match the current source state.
    if affected_bounds is None and _canonical_src_mtime is not None:
        try:
            upload_dedup.record_level_complete(
                _dedup_conn, _dedup_lock, level,
                _canonical_src_mtime, bytes_written,
            )
        except Exception:
            logger.exception(
                "Level %s: failed to record level-complete marker (non-fatal)",
                level,
            )
    elif affected_bounds is not None:
        # Partial regen produced a level whose contents no longer match
        # any previously cached full-level snapshot. Invalidate so a
        # later full regen actually does the work.
        try:
            upload_dedup.invalidate_level(_dedup_conn, _dedup_lock, level)
        except Exception:
            pass


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
                # Tier 3.2 (May 2026): drop the snapshot-local sidecar
                # RGBA cache (hardlinked from the shared cache in
                # ``_snapshot_combined_db``) so stale files don't
                # accumulate on the persistent disk.
                if db_path:
                    for orphan in (db_path + ".cache.db",):
                        try:
                            os.unlink(orphan)
                        except OSError:
                            pass
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

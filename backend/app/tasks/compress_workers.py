"""Background workers that compress R2 artefacts asynchronously.

Two queues live here:

* ``combined`` — re-compresses ``globalservermap.db`` to the
  ``globalservermap.db.zst`` sibling after every approval merge / restore.
  Latest-wins via a single in-process lock; a stale .zst is acceptable
  because the reader's fallback path always treats the raw object as the
  source of truth (matched by ``x-amz-meta-source-etag``).

* ``archive`` — moves a freshly-approved contribution from
  ``pending/<id>.db`` to ``archived/<id>.db.zst`` (and the same for
  ``undo/<id>.replaced.db``). Driven by an in-memory queue that is
  re-seeded at startup by a leak sweeper so a SIGKILL mid-compress
  never leaves an object stranded.

Both workers are daemon threads with a small state machine: ``idle`` ->
``running`` -> ``idle``. They honour the ``heavy_compute_enabled`` kill
switch so a small Render dyno can pause the work until an admin kicks
it manually.

The status of the **last** completed combined-DB run is mirrored into
:func:`~app.routes.admin_settings.record_compress_run` so the UI's
"Last compression run" line reflects reality.
"""

from __future__ import annotations

import logging
import os
import queue
import tempfile
import threading
import time
from typing import Optional, Tuple

logger = logging.getLogger("uvicorn.error")


# ---------------------------------------------------------------------------
# Shared kill-switch helper
# ---------------------------------------------------------------------------

def _heavy_compute_allowed() -> bool:
    try:
        from ..core.feature_flags import is_heavy_compute_allowed
        return is_heavy_compute_allowed()
    except Exception:
        logger.exception("compress_workers: heavy-compute check failed")
        return True


def _compression_enabled() -> bool:
    try:
        from ..core.feature_flags import is_feature_enabled
        return is_feature_enabled("compress_artefacts")
    except Exception:
        logger.exception("compress_workers: compress_artefacts flag check failed")
        return False


def _current_settings() -> Tuple[int, int]:
    """Return the (level, resolved_threads) tuple from app_settings."""
    from ..core import compression as comp
    from ..routes.admin_settings import get_compression_settings
    s = get_compression_settings()
    return int(s["level"]), comp.resolve_threads(s["threads_preset"])


# ---------------------------------------------------------------------------
# Combined DB compression worker — latest-wins
# ---------------------------------------------------------------------------

_combined_compress_lock = threading.Lock()
_combined_pending_path: Optional[str] = None
_combined_pending_etag: str = ""
_combined_pending_lock = threading.Lock()
_combined_thread: Optional[threading.Thread] = None


def schedule_combined_compress(local_path: str, source_etag: str) -> None:
    """Hand the merged-but-not-yet-compressed combined DB to the worker.

    ``local_path`` is consumed (deleted) by the worker; the caller MUST
    NOT delete it. ``source_etag`` is the ETag of the freshly-uploaded
    raw ``COMBINED_DB_KEY`` and gets embedded in the .zst sibling's
    ``x-amz-meta-source-etag`` so the reader can detect a stale archive.

    The latest call wins: if a previous queued path is still waiting it
    is unlinked and replaced. This is safe because every successful raw
    upload supersedes whatever the previous .zst was based on.
    """
    if not _compression_enabled():
        # Flag OFF — the raw upload alone is the canonical state.
        try:
            os.unlink(local_path)
        except OSError:
            pass
        return

    global _combined_pending_path, _combined_pending_etag, _combined_thread
    with _combined_pending_lock:
        # Drop any previously queued path — its source ETag is now stale.
        if _combined_pending_path and _combined_pending_path != local_path:
            try:
                os.unlink(_combined_pending_path)
            except OSError:
                pass
        _combined_pending_path = local_path
        _combined_pending_etag = source_etag

        if _combined_thread is None or not _combined_thread.is_alive():
            t = threading.Thread(
                target=_combined_worker_loop,
                name="combined-compress-worker",
                daemon=True,
            )
            _combined_thread = t
            t.start()


def _claim_combined_pending() -> Tuple[Optional[str], str]:
    global _combined_pending_path, _combined_pending_etag
    with _combined_pending_lock:
        path = _combined_pending_path
        etag = _combined_pending_etag
        _combined_pending_path = None
        _combined_pending_etag = ""
    return path, etag


def _combined_worker_loop() -> None:
    while True:
        path, source_etag = _claim_combined_pending()
        if not path:
            return
        # Hold the global compress lock so we serialise with archive jobs
        # and never run two large zstd encoders concurrently on a small
        # Render dyno.
        with _combined_compress_lock:
            _run_combined_compress(path, source_etag)


def _run_combined_compress(local_path: str, source_etag: str) -> None:
    from ..core import compression as comp
    from ..core import r2_storage
    from ..routes.admin_settings import record_compress_run

    started_at = time.time()
    record_compress_run(
        kind="combined",
        started_at=started_at,
        finished_at=None,
        input_bytes=0,
        output_bytes=0,
        elapsed_seconds=0.0,
        error=None,
    )

    if not _heavy_compute_allowed():
        logger.info(
            "combined-compress: heavy_compute_enabled is OFF; deferring %s",
            local_path,
        )
        # Re-queue so a later kick picks it up. We hold ownership of the
        # local path, so put it back atomically.
        with _combined_pending_lock:
            global _combined_pending_path, _combined_pending_etag
            if _combined_pending_path is None:
                _combined_pending_path = local_path
                _combined_pending_etag = source_etag
                return
        try:
            os.unlink(local_path)
        except OSError:
            pass
        return

    level, threads = _current_settings()
    out_path = local_path + ".zst"
    try:
        metrics = comp.compress_file(
            local_path, out_path, level=level, threads=threads,
        )
        r2_storage.upload_file_with_metadata(
            out_path,
            r2_storage.COMBINED_DB_ZSTD_KEY,
            metadata={"source-etag": source_etag},
        )
        # Drop any locally-cached .zst sidecar so the next reader downloads
        # the freshly-uploaded one.
        try:
            from ..routes.contribute_r2 import invalidate_combined_db_cache
            invalidate_combined_db_cache()
        except Exception:
            pass

        finished = time.time()
        record_compress_run(
            kind="combined",
            started_at=started_at,
            finished_at=finished,
            input_bytes=int(metrics["input_bytes"]),
            output_bytes=int(metrics["output_bytes"]),
            elapsed_seconds=float(metrics["elapsed_seconds"]),
            error=None,
        )
        logger.info(
            "combined-compress: %.1f MiB -> %.1f MiB (ratio %.3f) in %.1fs",
            metrics["input_bytes"] / (1024 * 1024),
            metrics["output_bytes"] / (1024 * 1024),
            metrics["ratio"],
            metrics["elapsed_seconds"],
        )
    except Exception as exc:
        logger.exception("combined-compress: failed for %s", local_path)
        record_compress_run(
            kind="combined",
            started_at=started_at,
            finished_at=time.time(),
            error=str(exc),
        )
    finally:
        for p in (local_path, out_path):
            try:
                os.unlink(p)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Per-contribution archive worker
#
# Items in the queue are contribution ids. The worker downloads the
# matching ``pending/<id>.db`` (and ``undo/<id>.replaced.db`` if it
# exists), compresses each to a temp .zst, uploads to the archived /
# undo-replaced key, then deletes the source. Crash-resilient via the
# leak sweeper which re-enqueues anything that didn't make it through.
# ---------------------------------------------------------------------------

_archive_queue: "queue.Queue[str]" = queue.Queue()
_archive_seen: set = set()
_archive_seen_lock = threading.Lock()
_archive_thread: Optional[threading.Thread] = None
_archive_thread_lock = threading.Lock()


def schedule_archive_compress(contribution_id: str) -> None:
    """Enqueue ``contribution_id`` for async archive compression.

    Idempotent: a contribution already in the queue is not re-queued.
    Auto-spawns the worker thread if one isn't running.
    """
    if not _compression_enabled():
        # Caller's fallback (synchronous ``move_object``) handles the
        # flag-OFF case; nothing to do here.
        return

    with _archive_seen_lock:
        if contribution_id in _archive_seen:
            return
        _archive_seen.add(contribution_id)
    _archive_queue.put(contribution_id)
    _ensure_archive_worker()


def _ensure_archive_worker() -> None:
    global _archive_thread
    with _archive_thread_lock:
        if _archive_thread is None or not _archive_thread.is_alive():
            t = threading.Thread(
                target=_archive_worker_loop,
                name="archive-compress-worker",
                daemon=True,
            )
            _archive_thread = t
            t.start()


def _archive_worker_loop() -> None:
    while True:
        try:
            cid = _archive_queue.get(timeout=5.0)
        except queue.Empty:
            return
        try:
            if not _heavy_compute_allowed():
                # Drop the seen-marker and exit — sweeper will re-enqueue.
                with _archive_seen_lock:
                    _archive_seen.discard(cid)
                return
            with _combined_compress_lock:
                _run_archive_compress(cid)
        finally:
            with _archive_seen_lock:
                _archive_seen.discard(cid)
            _archive_queue.task_done()


def _run_archive_compress(contribution_id: str) -> None:
    """Compress the pending DB (and replaced-undo DB if present) for one
    contribution into their archived .zst keys, then delete the sources.

    Each artefact is processed independently — a failure on one does not
    abort the other. Verifies the upload succeeded before deleting the
    source so a crash never loses data; the leak sweeper picks up any
    half-finished work.
    """
    from ..core import compression as comp
    from ..core import r2_storage

    level, threads = _current_settings()

    pending_key = r2_storage.pending_db_key(contribution_id)
    archived_key = r2_storage.archived_db_key(contribution_id, compressed=True)
    undo_replaced_raw = f"{r2_storage.UNDO_KEY_PREFIX}{contribution_id}.replaced.db"
    undo_replaced_zst = r2_storage.undo_replaced_key(contribution_id, compressed=True)

    _compress_one_archive_artefact(pending_key, archived_key, level, threads)
    if r2_storage.object_exists(undo_replaced_raw):
        _compress_one_archive_artefact(
            undo_replaced_raw, undo_replaced_zst, level, threads,
        )


def _compress_one_archive_artefact(
    src_key: str,
    dst_key: str,
    level: int,
    threads: int,
) -> None:
    from ..core import compression as comp
    from ..core import r2_storage

    if not r2_storage.object_exists(src_key):
        # Already moved (e.g. by a previous run) — nothing to do.
        return

    fd_in, src_path = tempfile.mkstemp(suffix=".db")
    os.close(fd_in)
    fd_out, dst_path = tempfile.mkstemp(suffix=".db.zst")
    os.close(fd_out)
    try:
        r2_storage.download_to_path(src_key, src_path)
        comp.compress_file(src_path, dst_path, level=level, threads=threads)
        # Embed the source key so admin tooling can reason about provenance.
        r2_storage.upload_file_with_metadata(
            dst_path, dst_key, metadata={"source-key": src_key},
        )
        # Verify the upload landed before unlinking the source.
        if not r2_storage.object_exists(dst_key):
            raise RuntimeError(f"compressed upload missing after put: {dst_key}")
        r2_storage.delete_object(src_key)
    finally:
        for p in (src_path, dst_path):
            try:
                os.unlink(p)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Leak sweeper — re-enqueue archive jobs that crashed mid-flight.
# Called hourly from cleanup_history's scheduler and once at startup.
# ---------------------------------------------------------------------------

_SWEEP_GRACE_SECONDS = 60 * 60  # one hour


def sweep_pending_archives() -> int:
    """Find ``pending/<id>.db`` objects older than the grace window for
    contributions that are no longer in ``status='pending'`` and re-enqueue
    them. Returns the number of jobs scheduled."""
    if not _compression_enabled():
        return 0
    from ..core import database as db
    from ..core import r2_storage

    enqueued = 0
    try:
        prefix = "pending/"
        listing = r2_storage.list_keys_with_prefix(prefix)
    except Exception:
        logger.exception("compress_workers: sweep listing failed")
        return 0

    for key in listing:
        if not key.endswith(".db"):
            continue
        cid = key[len(prefix):-len(".db")]
        try:
            row = db.get_contribution(cid)
        except Exception:
            continue
        if not row:
            continue
        # Only sweep when the row has moved past 'pending' — an upload
        # legitimately in flight should be left alone. The grace window
        # is enforced by the row state transition (validated → approved →
        # archive scheduled), not by file age, so a freshly uploaded
        # but not-yet-validated file is automatically skipped.
        if row.get("status") in ("pending", None):
            continue
        schedule_archive_compress(cid)
        enqueued += 1
    if enqueued:
        logger.info("compress_workers: sweep re-enqueued %d archive job(s)", enqueued)
    return enqueued


def kick_on_startup() -> None:
    """Resume any archive work left behind by a previous process.

    Called from ``main.py`` lifespan startup. Cheap when the flag is OFF
    (no-op) or there's nothing to sweep.
    """
    if not _compression_enabled():
        return
    try:
        sweep_pending_archives()
    except Exception:
        logger.exception("compress_workers: startup sweep failed")
    # Resume an interrupted migration if one was in flight.
    try:
        from ..routes.admin_settings import get_migration_status
        snap = get_migration_status()
        if snap.get("phase") == "running":
            start_migration(resume=True)
    except Exception:
        logger.exception("compress_workers: migration resume failed")


# ---------------------------------------------------------------------------
# Eager migration runner (OFF -> ON flag flip)
# ---------------------------------------------------------------------------

_migration_lock = threading.Lock()
_migration_thread: Optional[threading.Thread] = None
_migration_stop = threading.Event()


def is_migration_running() -> bool:
    return _migration_thread is not None and _migration_thread.is_alive()


def start_migration(*, resume: bool = False) -> bool:
    """Spawn the migration worker if not already running.

    Returns True on spawn, False if a worker was already alive. The worker
    walks every contribution with an active ``archived/<id>.db`` and
    converts it to ``archived/<id>.db.zst`` (and the same for
    ``undo/<id>.replaced.db``). Honours the ``heavy_compute_enabled``
    kill switch — pauses cleanly when flipped OFF mid-run.
    """
    global _migration_thread
    with _migration_lock:
        if _migration_thread is not None and _migration_thread.is_alive():
            return False
        _migration_stop.clear()
        t = threading.Thread(
            target=_migration_loop,
            name="compress-migration",
            kwargs={"resume": resume},
            daemon=True,
        )
        _migration_thread = t
        t.start()
        return True


def stop_migration() -> None:
    """Signal the migration runner to exit at the next safe point."""
    _migration_stop.set()


def _collect_migration_cids() -> list:
    """Enumerate contribution ids that still have a raw ``.db`` artefact
    under ``archived/`` or ``undo/`` in R2. Source of truth is the bucket
    listing — the DB's ``preview_retained_until`` is intentionally not
    consulted so orphaned objects (e.g. rows whose retention deadline has
    passed but cleanup hasn't run yet) still get converted.

    A contribution appears at most once even if it has both an archived
    and an undo-replaced artefact; ``_migrate_one_contribution`` handles
    both per cid.
    """
    from ..core import r2_storage

    cids: list = []
    seen: set = set()

    def _add(cid: str) -> None:
        if cid and cid not in seen:
            seen.add(cid)
            cids.append(cid)

    archived_prefix = "archived/"
    for key in r2_storage.list_keys_with_prefix(archived_prefix):
        # Raw artefacts only — skip already-migrated .db.zst siblings.
        if not key.endswith(".db"):
            continue
        _add(key[len(archived_prefix):-len(".db")])

    undo_prefix = r2_storage.UNDO_KEY_PREFIX
    undo_suffix = ".replaced.db"
    for key in r2_storage.list_keys_with_prefix(undo_prefix):
        if not key.endswith(undo_suffix):
            continue
        _add(key[len(undo_prefix):-len(undo_suffix)])

    cids.sort()
    return cids


def _migration_loop(*, resume: bool) -> None:
    from ..core import compression as comp
    from ..core import r2_storage
    from ..routes.admin_settings import update_migration_status

    if not _compression_enabled():
        update_migration_status(
            phase="error",
            error="compress_artefacts flag is OFF — refusing to migrate",
            finished_at=time.time(),
        )
        return

    try:
        cids = _collect_migration_cids()
    except Exception as exc:
        logger.exception("migration: failed to enumerate active archives")
        update_migration_status(
            phase="error", error=str(exc), finished_at=time.time(),
        )
        return

    total = len(cids)
    update_migration_status(
        phase="running",
        total=total,
        processed=0,
        skipped=0,
        failed=0,
        started_at=time.time() if not resume else None,
        finished_at=None,
        error=None,
    )

    processed = 0
    skipped = 0
    failed = 0
    for cid in cids:
        if _migration_stop.is_set():
            update_migration_status(phase="idle", finished_at=time.time())
            return
        if not _heavy_compute_allowed():
            # Pause: leave phase=running so kick_on_startup will resume
            # when the kill switch is flipped back on.
            logger.info("migration: paused — heavy_compute_enabled is OFF")
            update_migration_status(
                phase="running",
                processed=processed,
                skipped=skipped,
                failed=failed,
            )
            return

        try:
            level, threads = _current_settings()
            converted = _migrate_one_contribution(cid, level, threads)
            if converted:
                processed += 1
            else:
                skipped += 1
        except Exception:
            logger.exception("migration: failed for %s", cid)
            failed += 1
        finally:
            update_migration_status(
                processed=processed, skipped=skipped, failed=failed,
            )

    update_migration_status(
        phase="done", finished_at=time.time(),
        processed=processed, skipped=skipped, failed=failed,
    )
    logger.info(
        "migration: done — %d converted, %d skipped, %d failed",
        processed, skipped, failed,
    )


def _migrate_one_contribution(cid: str, level: int, threads: int) -> bool:
    """Convert any raw archived/undo-replaced artefact for ``cid`` to .zst.
    Returns True if at least one artefact was converted."""
    from ..core import r2_storage

    converted = False
    raw_archive = r2_storage.archived_db_key(cid)
    if r2_storage.object_exists(raw_archive) and not r2_storage.object_exists(
        raw_archive + ".zst"
    ):
        _compress_one_archive_artefact(
            raw_archive, raw_archive + ".zst", level, threads,
        )
        converted = True

    raw_undo = f"{r2_storage.UNDO_KEY_PREFIX}{cid}.replaced.db"
    if r2_storage.object_exists(raw_undo) and not r2_storage.object_exists(
        raw_undo + ".zst"
    ):
        _compress_one_archive_artefact(
            raw_undo, raw_undo + ".zst", level, threads,
        )
        converted = True

    return converted

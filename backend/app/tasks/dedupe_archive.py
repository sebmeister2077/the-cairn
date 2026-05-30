"""Per-submitter archive dedupe worker.

When the approve flow finishes archiving a full-map gap-fill contribution
(``update_region is None``), it kicks ``start_job(cid)`` here. The worker:

  1. Looks up the same submitter's most recent prior approved archive that
     is still eligible for dedupe (full DB, not region-pruned, not already
     superseded, not already deleted).
  2. Cheap pre-check: if ``prev.tile_count >= row.tile_count`` the new
     contribution can't strictly supersede the old — bail out without any
     R2 download.
  3. Downloads both ``archived/<id>.db[.zst]`` blobs and runs a SQLite
     anti-join on ``mappiece.position``. If every old position appears in
     the new file (and the new file has strictly more rows) the old archive
     is considered redundant.
  4. Deletes the old R2 object (both raw and .zst forms, in case the
     compression flag flipped) and marks the row via
     ``db.mark_archive_superseded``.

Failures are best-effort and only emit a log line — the worker must never
block approval or corrupt the archives. Mirrors the single-thread / lock
pattern used by :mod:`backend.app.tasks.match_score`.
"""

from __future__ import annotations

import collections
import logging
import os
import tempfile
import threading
from typing import Optional

from ..core import accounts_db, database as db, r2_storage


logger = logging.getLogger("uvicorn.error")

_job_lock = threading.Lock()
_active_thread: Optional[threading.Thread] = None
_pending: "collections.deque[str]" = collections.deque()
_seen: set = set()


def is_job_running() -> bool:
    return _active_thread is not None and _active_thread.is_alive()


def _process_one(cid: str) -> None:
    row = db.get_contribution(cid)
    if not row:
        return
    if row.get("status") != "approved":
        return
    if row.get("update_region_min_x") is not None:
        # Region-pruned archive — different shape, skip dedupe.
        return
    if row.get("archived_is_region_pruned"):
        return
    submitter_id = row.get("submitted_by_key_id")
    if not submitter_id:
        return

    prev = db.get_previous_supersedable_archive(str(submitter_id), exclude_cid=cid)
    if not prev:
        logger.info("dedupe_archive: %s — no prior archive to compare", cid)
        return

    new_tile_count = row.get("tile_count") or 0
    old_tile_count = prev.get("tile_count") or 0
    if old_tile_count == 0 or old_tile_count >= new_tile_count:
        logger.info(
            "dedupe_archive: %s — prev %s has %d tiles vs new %d, skipping",
            cid, prev["id"], old_tile_count, new_tile_count,
        )
        return

    new_key = r2_storage.archived_db_key(cid)
    old_key = r2_storage.archived_db_key(prev["id"])

    new_fd, new_path = tempfile.mkstemp(suffix=".dedupe.new.db")
    os.close(new_fd)
    old_fd, old_path = tempfile.mkstemp(suffix=".dedupe.old.db")
    os.close(old_fd)
    try:
        try:
            r2_storage.download_artefact_to_raw_path(new_key, new_path)
        except FileNotFoundError:
            logger.warning(
                "dedupe_archive: %s — new archive missing in R2, aborting", cid,
            )
            return
        try:
            r2_storage.download_artefact_to_raw_path(old_key, old_path)
        except FileNotFoundError:
            # Old archive already gone (e.g. cleanup_history beat us) —
            # still mark the row so future runs don't keep retrying.
            logger.info(
                "dedupe_archive: %s — prev %s archive already gone, marking",
                cid, prev["id"],
            )
            try:
                db.mark_archive_superseded(prev["id"], cid)
            except Exception:
                logger.exception("dedupe_archive: mark failed for %s", prev["id"])
            return

        # Local import — keeps this module cheap when archive dedupe is
        # never triggered (most non-leader processes never load it).
        from ..routes.contribute_r2 import _old_archive_is_strict_subset
        is_subset = _old_archive_is_strict_subset(old_path, new_path)
        if not is_subset:
            logger.info(
                "dedupe_archive: %s — prev %s is not a strict subset, keeping",
                cid, prev["id"],
            )
            return

        # Delete both raw and .zst forms (only one should exist; cheap to
        # call on a missing key).
        try:
            r2_storage.delete_object(old_key)
            r2_storage.delete_object(old_key + ".zst")
        except Exception:
            logger.exception(
                "dedupe_archive: R2 delete failed for %s", prev["id"],
            )
            return

        try:
            db.mark_archive_superseded(prev["id"], cid)
        except Exception:
            logger.exception(
                "dedupe_archive: mark_archive_superseded failed for %s",
                prev["id"],
            )
            return

        try:
            accounts_db.audit_log(
                "",
                "contribution.archive_superseded",
                target=prev["id"],
                metadata={
                    "superseded_by": cid,
                    "old_tile_count": int(old_tile_count),
                    "new_tile_count": int(new_tile_count),
                },
                admin_key_id=str(submitter_id),
            )
        except Exception:
            logger.exception("dedupe_archive: audit log failed for %s", prev["id"])

        logger.info(
            "dedupe_archive: %s — superseded prev %s (saved %d-tile archive)",
            cid, prev["id"], old_tile_count,
        )
    finally:
        for p in (new_path, old_path):
            try:
                os.unlink(p)
            except OSError:
                pass


def _worker_loop() -> None:
    global _active_thread
    try:
        while True:
            with _job_lock:
                if not _pending:
                    _active_thread = None
                    return
                cid = _pending.popleft()
                _seen.discard(cid)
            try:
                _process_one(cid)
            except Exception:
                logger.exception("dedupe_archive: contribution %s raised", cid)
    finally:
        with _job_lock:
            if _active_thread is threading.current_thread():
                _active_thread = None


def start_job(cid: str) -> bool:
    """Enqueue ``cid`` for dedupe and ensure the worker thread is running.

    Returns True when a new thread was spawned, False if the job was
    coalesced into a running queue. Safe to call from the approve flow
    inside try/except — failures are logged but never raised.
    """
    global _active_thread
    if not cid:
        return False
    with _job_lock:
        if cid in _seen:
            return False
        _pending.append(cid)
        _seen.add(cid)
        if _active_thread is not None and _active_thread.is_alive():
            return False
        t = threading.Thread(
            target=_worker_loop,
            name="dedupe-archive-worker",
            daemon=True,
        )
        _active_thread = t
        t.start()
        return True

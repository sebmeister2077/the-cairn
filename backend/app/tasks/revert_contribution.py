"""Async worker that performs the per-contribution revert.

Why a worker?

The revert flow downloads the entire combined ``globalservermap.db``
from R2, mutates it in-process via SQLite (deleting the contribution's
added positions and restoring overwrites from the undo blobs), and
re-uploads the result. On the small Render instance the backend runs
on, this routinely takes longer than Render's edge HTTP timeout
(~100 s) for a multi-GB combined DB, surfacing in the browser as 502
/ "Failed to fetch". The user-facing
``POST /api/admin/contributions/{id}/revert`` therefore only enqueues
the job (sets ``revert_status='queued'``) and returns 202; this
worker drains the queue.

Architecture mirrors :mod:`backend.app.tasks.approve_contribution`
exactly — single in-process daemon thread, ``FOR UPDATE SKIP LOCKED``
claim semantics so multiple workers / processes can race safely on
the same Postgres table, and a ``kick_on_startup`` hook so a backend
restart mid-revert resumes within seconds.

The revert itself is idempotent under crash: ``acquire_map_lock``
serialises across processes, the SQLite mutations happen on a local
copy, and the upload to R2 is the atomic commit point — if we crash
before upload the combined DB is untouched and the worker simply
re-claims the queued row on next startup.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Optional

from ..core import database as db

logger = logging.getLogger("uvicorn.error")

_job_lock = threading.Lock()
_active_thread: Optional[threading.Thread] = None


def is_job_running() -> bool:
    return _active_thread is not None and _active_thread.is_alive()


def _process_one(job: dict) -> None:
    """Run the revert for one claimed contribution. Local imports keep
    the module cheap to import at app startup."""
    from ..routes.admin_contributions import (
        run_revert_merge,
        RevertRetryable,
        RevertFatal,
    )

    cid = job["id"]
    requested_by_key = job.get("revert_requested_by_key") or ""
    attempts = int(job.get("revert_attempts") or 0)
    try:
        result = run_revert_merge(cid, requested_by_key=requested_by_key)
        logger.info(
            "revert_contribution: %s reverted (deleted=%s restored=%s combined_total=%s)",
            cid,
            result.get("deleted"),
            result.get("restored"),
            result.get("combined_total"),
        )
        return
    except RevertRetryable as exc:
        logger.warning(
            "revert_contribution: %s retryable failure (attempt %s/%s): %s",
            cid, attempts, db.REVERT_MAX_ATTEMPTS, exc,
        )
        if attempts >= db.REVERT_MAX_ATTEMPTS:
            try:
                db.set_revert_failed(
                    cid, f"Gave up after {attempts} attempts: {exc}"
                )
            except Exception:
                logger.exception("revert_contribution: persist failure for %s", cid)
            return
        try:
            db.enqueue_revert(cid, requested_by_key=requested_by_key)
        except Exception:
            logger.exception("revert_contribution: re-queue failed for %s", cid)
        return
    except RevertFatal as exc:
        logger.warning("revert_contribution: %s fatal: %s", cid, exc)
        try:
            db.set_revert_failed(cid, str(exc))
        except Exception:
            logger.exception("revert_contribution: persist fatal for %s", cid)
        return
    except Exception as exc:
        logger.exception("revert_contribution: %s unexpected error", cid)
        if attempts >= db.REVERT_MAX_ATTEMPTS:
            try:
                db.set_revert_failed(
                    cid, f"Gave up after {attempts} attempts: "
                         f"{type(exc).__name__}: {exc}",
                )
            except Exception:
                logger.exception(
                    "revert_contribution: persist unknown failure for %s", cid
                )
            return
        try:
            db.enqueue_revert(cid, requested_by_key=requested_by_key)
        except Exception:
            logger.exception(
                "revert_contribution: re-queue after unknown error failed for %s",
                cid,
            )


def _worker_loop() -> None:
    """Drain queued reverts until the queue is empty."""
    global _active_thread
    try:
        while True:
            try:
                job = db.claim_pending_revert_job()
            except Exception:
                logger.exception("revert_contribution: claim failed; exiting")
                job = None

            if not job:
                with _job_lock:
                    try:
                        job = db.claim_pending_revert_job()
                    except Exception:
                        logger.exception(
                            "revert_contribution: claim under lock failed"
                        )
                        job = None
                    if not job:
                        _active_thread = None
                        return

            cid = job["id"]
            logger.info(
                "revert_contribution: processing %s (attempt %s)",
                cid, job.get("revert_attempts"),
            )
            _process_one(job)
    finally:
        with _job_lock:
            if _active_thread is threading.current_thread():
                _active_thread = None


def start_job(cid: Optional[str] = None, *, force: bool = False) -> bool:
    """Ensure the worker thread is running. ``cid`` is just a hint — the
    worker always drains the full queue, so callers don't need to pass
    it. ``force=True`` bypasses the ``heavy_compute_enabled`` kill
    switch (reserved for admin "run heavy compute now" flows). Returns
    True if a new worker was spawned, False if one is already running
    or the kill switch blocked the spawn."""
    global _active_thread
    if not force:
        try:
            from ..core.feature_flags import is_heavy_compute_allowed
            if not is_heavy_compute_allowed():
                logger.info(
                    "revert_contribution: skipping spawn — heavy_compute_enabled is OFF"
                )
                return False
        except Exception:
            logger.exception("revert_contribution: feature-flag check failed")
    with _job_lock:
        if _active_thread is not None and _active_thread.is_alive():
            return False
        if cid is None:
            try:
                if not db.has_pending_revert_jobs():
                    return False
            except Exception:
                logger.exception("revert_contribution: pending check failed")
                return False

        t = threading.Thread(
            target=_worker_loop,
            name="revert-contribution-worker",
            daemon=True,
        )
        _active_thread = t
        t.start()
        return True


def kick_on_startup() -> None:
    """Re-queue any rows left in ``revert_status='running'`` from a
    previous process and start the worker. Called from ``main.py``'s
    startup hook so a backend restart mid-revert picks up where it
    left off."""
    if os.getenv("REVERT_CONTRIBUTION_DISABLE_STARTUP_KICK") == "1":
        return
    try:
        recovered = db.reset_running_reverts()
        if recovered:
            logger.info(
                "revert_contribution: re-queued %d row(s) left running by "
                "previous process", recovered,
            )
    except Exception:
        logger.exception("revert_contribution: reset_running_reverts failed")
    try:
        start_job()
    except Exception:
        logger.exception("revert_contribution: startup kick failed")

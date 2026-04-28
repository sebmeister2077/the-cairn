"""Async worker that performs the contribution merge into the combined map.

Why a worker?

The merge of a pending contribution into ``globalservermap.db`` requires
downloading the entire combined DB from R2, running an in-process SQLite
merge, and uploading the (usually much larger) combined DB back to R2.
On the small Render instance the backend runs on, this routinely takes
longer than Render's edge HTTP timeout (~100 s), surfacing in the browser
as 502 / "Failed to fetch". The user-facing ``POST /contribute/{id}/approve``
therefore only enqueues the job (sets ``approval_status='queued'``) and
returns 202; this worker drains the queue.

Architecture mirrors :mod:`backend.app.tasks.validate_uploads` —
single in-process daemon thread, ``FOR UPDATE SKIP LOCKED`` claim
semantics so multiple workers / processes can race safely on the same
Postgres table, and a ``kick_on_startup`` hook so a backend restart
mid-merge resumes within seconds.

The merge itself is idempotent: ``acquire_map_lock`` serialises across
processes, and the gap-fill is driven by an explicit per-position
existence lookup, so a re-run after a crash mid-merge is safe.
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
    """Run the merge for one claimed contribution. Local imports keep the
    module cheap to import at app startup."""
    from ..routes.contribute_r2 import (
        run_approval_merge,
        ApprovalRetryable,
        ApprovalFatal,
    )

    cid = job["id"]
    attempts = int(job.get("approval_attempts") or 0)
    try:
        result = run_approval_merge(cid)
        logger.info("approve_contribution: %s merged: %s", cid, result.get("message"))
        return
    except ApprovalRetryable as exc:
        logger.warning(
            "approve_contribution: %s retryable failure (attempt %s/%s): %s",
            cid, attempts, db.APPROVAL_MAX_ATTEMPTS, exc,
        )
        if attempts >= db.APPROVAL_MAX_ATTEMPTS:
            try:
                db.set_approval_failed(
                    cid, f"Gave up after {attempts} attempts: {exc}"
                )
            except Exception:
                logger.exception("approve_contribution: persist failure for %s", cid)
            return
        # Re-queue so the same worker (or another) picks it up next pass.
        try:
            db.enqueue_approval(cid)
        except Exception:
            logger.exception("approve_contribution: re-queue failed for %s", cid)
        return
    except ApprovalFatal as exc:
        logger.warning("approve_contribution: %s fatal: %s", cid, exc)
        try:
            db.set_approval_failed(cid, str(exc))
        except Exception:
            logger.exception("approve_contribution: persist fatal for %s", cid)
        return
    except Exception as exc:
        logger.exception("approve_contribution: %s unexpected error", cid)
        # Treat unknown exceptions like retryables but with the same cap.
        if attempts >= db.APPROVAL_MAX_ATTEMPTS:
            try:
                db.set_approval_failed(
                    cid, f"Gave up after {attempts} attempts: "
                         f"{type(exc).__name__}: {exc}",
                )
            except Exception:
                logger.exception(
                    "approve_contribution: persist unknown failure for %s", cid
                )
            return
        try:
            db.enqueue_approval(cid)
        except Exception:
            logger.exception(
                "approve_contribution: re-queue after unknown error failed for %s",
                cid,
            )


def _worker_loop() -> None:
    """Drain queued approvals until the queue is empty."""
    global _active_thread
    try:
        while True:
            try:
                job = db.claim_pending_approval_job()
            except Exception:
                logger.exception("approve_contribution: claim failed; exiting")
                job = None

            if not job:
                with _job_lock:
                    try:
                        job = db.claim_pending_approval_job()
                    except Exception:
                        logger.exception(
                            "approve_contribution: claim under lock failed"
                        )
                        job = None
                    if not job:
                        _active_thread = None
                        return

            cid = job["id"]
            logger.info(
                "approve_contribution: processing %s (attempt %s)",
                cid, job.get("approval_attempts"),
            )
            _process_one(job)
    finally:
        with _job_lock:
            if _active_thread is threading.current_thread():
                _active_thread = None


def start_job(cid: Optional[str] = None) -> bool:
    """Ensure the worker thread is running. ``cid`` is just a hint — the
    worker always drains the full queue, so callers don't need to pass it.
    Returns True if a new worker was spawned, False if one is already
    running."""
    global _active_thread
    with _job_lock:
        if _active_thread is not None and _active_thread.is_alive():
            return False
        if cid is None:
            try:
                if not db.has_pending_approval_jobs():
                    return False
            except Exception:
                logger.exception("approve_contribution: pending check failed")
                return False

        t = threading.Thread(
            target=_worker_loop,
            name="approve-contribution-worker",
            daemon=True,
        )
        _active_thread = t
        t.start()
        return True


def kick_on_startup() -> None:
    """Re-queue any rows left in ``approval_status='running'`` from a
    previous process and start the worker. Called from ``main.py``'s
    startup hook so a backend restart mid-merge picks up where it left
    off."""
    if os.getenv("APPROVE_CONTRIBUTION_DISABLE_STARTUP_KICK") == "1":
        return
    try:
        recovered = db.reset_running_approvals()
        if recovered:
            logger.info(
                "approve_contribution: re-queued %d row(s) left running by "
                "previous process", recovered,
            )
    except Exception:
        logger.exception("approve_contribution: reset_running_approvals failed")
    try:
        start_job()
    except Exception:
        logger.exception("approve_contribution: startup kick failed")

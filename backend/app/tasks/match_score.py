"""Phase 1 — async worker that computes match scores for pending contributions.

A pending contribution is marked ``match_score_status='pending'`` by the
``/contribute/complete`` route. This worker drains those rows one at a time,
downloads the combined map and the pending DB to a temp directory, and runs
:func:`backend.app.routes.contribute_r2._compute_match_score` against them.

Architecture mirrors :mod:`backend.app.tasks.generate_map_levels`:

  * a single in-process worker thread
  * a Postgres-backed queue (here we just claim rows from ``contributions``
    where ``match_score_status='pending'``, so no separate table is needed)
  * ``start_job()`` enqueues by writing the row state, then ensures the
    worker thread is alive

The match score is **informational only** — it never blocks approval. A
permanently-failing row is retried up to ``MATCH_SCORE_MAX_ATTEMPTS`` times
and then left in ``match_score_status='failed'`` until an admin clicks the
"Recompute" button (which re-enqueues by calling ``set_match_score_pending``).
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


def _process_one(cid: str) -> None:
    """Run the scorer for one contribution and persist the result.

    Imports are local so this module stays cheap to import at app startup
    even before the contribute routes module is loaded.
    """
    from ..routes.contribute_r2 import _compute_match_score_for_contribution

    try:
        result = _compute_match_score_for_contribution(cid)
    except Exception as exc:
        logger.exception("match_score: contribution %s failed: %s", cid, exc)
        try:
            db.set_match_score_failed(cid, f"{type(exc).__name__}: {exc}")
        except Exception:
            logger.exception("match_score: also failed to persist failure for %s", cid)
        return

    try:
        db.set_match_score_ready(cid, result)
    except Exception:
        logger.exception("match_score: failed to persist result for %s", cid)


def _worker_loop() -> None:
    """Drain pending match-score jobs until the queue is empty."""
    global _active_thread
    try:
        while True:
            try:
                job = db.claim_pending_match_score_job()
            except Exception:
                logger.exception("match_score: failed to claim a job; exiting worker")
                job = None

            if not job:
                # Recheck under the lock so a producer cannot race past us.
                with _job_lock:
                    try:
                        job = db.claim_pending_match_score_job()
                    except Exception:
                        logger.exception("match_score: claim under lock failed")
                        job = None
                    if not job:
                        _active_thread = None
                        return

            cid = job["id"]
            logger.info("match_score: processing %s (attempt %s)", cid, job.get("match_score_attempts"))
            _process_one(cid)
    finally:
        # Belt-and-suspenders: if we exit through an unexpected path, clear
        # the thread handle so a future start_job can spawn a replacement.
        with _job_lock:
            if _active_thread is threading.current_thread():
                _active_thread = None


def start_job(cid: Optional[str] = None, *, force: bool = False) -> bool:
    """Ensure the worker thread is running.

    If ``cid`` is provided, callers should already have written
    ``match_score_status='pending'`` for that row before invoking us — we
    just kick the worker. ``force=True`` bypasses the
    ``heavy_compute_enabled`` kill switch and is reserved for the admin
    "Run heavy compute now" bulk endpoint. Returns True if a new worker
    was started, False if one was already running or if the kill switch
    blocked the spawn.
    """
    global _active_thread
    if not force:
        try:
            from ..core.feature_flags import is_feature_enabled_default
            if not is_feature_enabled_default("heavy_compute_enabled", True):
                logger.info(
                    "match_score: skipping spawn — heavy_compute_enabled is OFF"
                )
                return False
        except Exception:
            logger.exception("match_score: feature-flag check failed")
    with _job_lock:
        if _active_thread is not None and _active_thread.is_alive():
            return False
        # Quick check so we don't spawn a thread that immediately exits when
        # there's no pending work and no cid was hinted.
        if cid is None:
            try:
                if not db.has_pending_match_score_jobs():
                    return False
            except Exception:
                logger.exception("match_score: pending check failed")
                return False

        t = threading.Thread(
            target=_worker_loop,
            name="match-score-worker",
            daemon=True,
        )
        _active_thread = t
        t.start()
        return True


def kick_on_startup() -> None:
    """Best-effort: re-enqueue any rows left ``pending`` from a previous
    process. Called from ``main.py``'s startup hook so a backend restart
    mid-job doesn't strand contributions in 'pending' forever."""
    if os.getenv("MATCH_SCORE_DISABLE_STARTUP_KICK") == "1":
        return
    try:
        start_job()
    except Exception:
        logger.exception("match_score: startup kick failed")

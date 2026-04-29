"""Periodic poller that drains pending heavy-compute work.

The validate-uploads and match-score workers are normally kicked from two
places:

* the ``/contribute/complete`` request handler, when a fresh upload arrives;
* :func:`backend.app.tasks.<worker>.kick_on_startup`, called once at boot.

That covers the common case but leaves a hole: when the deployed Render
backend has ``heavy_compute_enabled`` OFF (small server, no headroom for
GB-sized validations), uploads land in Postgres as ``validation_status='pending'``
but no worker is ever spawned on prod. A developer running the backend
locally with ``HEAVY_COMPUTE_LOCAL_OVERRIDE=true`` against the production
database is the intended escape hatch — but their server only kicks
workers on its own startup, so any contribution uploaded *after* the local
process has been running just sits in 'pending' forever.

This poller closes that hole. It wakes every
``HEAVY_COMPUTE_POLL_INTERVAL_SECONDS`` (default 30s), and if heavy compute
is allowed in this process it asks each worker to ``start_job()``. The
worker calls are idempotent — they no-op when a worker is already running
or when there's nothing pending — so the poll is cheap.

On the prod backend (override unset, flag OFF) ``is_heavy_compute_allowed()``
returns False and the poller does nothing. Flip the flag back on, or run
the local override, and the next tick will pick up any backlog.
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

from ..config import settings


logger = logging.getLogger("uvicorn.error")

_lock = threading.Lock()
_timer: Optional[threading.Timer] = None
_stopped = False


def _tick() -> None:
    """One poll: if heavy compute is allowed, kick both workers."""
    try:
        from ..core.feature_flags import is_heavy_compute_allowed
        if not is_heavy_compute_allowed():
            return
    except Exception:
        logger.exception("heavy_compute_poller: feature-flag check failed")
        return

    try:
        from . import validate_uploads
        validate_uploads.start_job()
    except Exception:
        logger.exception("heavy_compute_poller: validate_uploads.start_job failed")

    try:
        from . import match_score
        match_score.start_job()
    except Exception:
        logger.exception("heavy_compute_poller: match_score.start_job failed")

    try:
        from . import approve_contribution
        approve_contribution.start_job()
    except Exception:
        logger.exception("heavy_compute_poller: approve_contribution.start_job failed")

    try:
        from . import generate_map_levels
        generate_map_levels.resume_pending_work()
    except Exception:
        logger.exception("heavy_compute_poller: generate_map_levels.resume_pending_work failed")


def _scheduled_run() -> None:
    global _timer
    try:
        _tick()
    except Exception:
        logger.exception("heavy_compute_poller: tick raised; will retry next interval")
    finally:
        with _lock:
            if _stopped:
                return
            _timer = threading.Timer(
                settings.HEAVY_COMPUTE_POLL_INTERVAL_SECONDS, _scheduled_run
            )
            _timer.daemon = True
            _timer.start()


def start() -> None:
    """Start the periodic poller. Idempotent — safe to call from app startup."""
    global _timer, _stopped
    with _lock:
        if _timer is not None and _timer.is_alive():
            return
        _stopped = False
        _timer = threading.Timer(
            settings.HEAVY_COMPUTE_POLL_INTERVAL_SECONDS, _scheduled_run
        )
        _timer.daemon = True
        _timer.start()


def stop() -> None:
    """Stop the periodic poller (used at app shutdown)."""
    global _timer, _stopped
    with _lock:
        _stopped = True
        if _timer is not None:
            _timer.cancel()
            _timer = None

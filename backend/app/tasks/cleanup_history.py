"""Daily sweep that deletes expired per-contribution archived ``.db`` files.

Approved contributions get a ``preview_retained_until`` deadline stamped on
their row by the approval flow. Once that deadline elapses, the
``archived/<id>.db`` (used to power per-contribution revert) can be deleted.

The history preview PNG (``history/<id>.png``) is **not** deleted by this
task — previews are kept indefinitely so the public "Recent contributions"
grid remains an all-time history.

The task runs on a single in-process timer thread that re-arms itself after
each sweep. Idempotent — re-running on the same set of rows is a no-op
because each cleanup also clears the ``preview_retained_until`` column.
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

from ..config import settings
from ..core import database as db
from ..core import r2_storage


logger = logging.getLogger("uvicorn.error")

_lock = threading.Lock()
_timer: Optional[threading.Timer] = None
_stopped = False


def _sweep_once() -> dict:
    """Delete the archived ``.db`` for rows whose retention has elapsed and
    clear ``preview_retained_until`` so the next sweep can skip them. The
    history preview PNG is intentionally left in place. Returns counts for
    logging."""
    rows = db.list_expired_history_contributions(limit=500)
    deleted_archives = 0
    for row in rows:
        cid = row["id"]
        # Archived .db only exists for approved contributions; safe to call
        # delete_object on a missing key (it silently no-ops).
        try:
            r2_storage.delete_object(r2_storage.archived_db_key(cid))
            deleted_archives += 1
        except Exception:
            logger.exception("cleanup_history: failed to delete archive %s", cid)
        try:
            db.set_preview_retained_until(cid, None)
        except Exception:
            logger.exception("cleanup_history: failed to clear retention for %s", cid)
    return {
        "rows": len(rows),
        "archives_deleted": deleted_archives,
    }


def run_now() -> dict:
    """Synchronous entry point — runs one sweep and returns counts.
    Useful for tests and the admin "Clean now" debug button."""
    return _sweep_once()


def _scheduled_run() -> None:
    global _timer
    try:
        result = _sweep_once()
        logger.info("cleanup_history: swept %s", result)
    except Exception:
        logger.exception("cleanup_history: sweep raised; will retry next interval")
    finally:
        with _lock:
            if _stopped:
                return
            _timer = threading.Timer(
                settings.HISTORY_CLEANUP_INTERVAL_SECONDS, _scheduled_run
            )
            _timer.daemon = True
            _timer.start()


def start() -> None:
    """Start the periodic cleanup. Idempotent — safe to call from app startup."""
    global _timer, _stopped
    with _lock:
        if _timer is not None and _timer.is_alive():
            return
        _stopped = False
        # Defer the first sweep so it doesn't compete with startup work.
        _timer = threading.Timer(
            settings.HISTORY_CLEANUP_INTERVAL_SECONDS, _scheduled_run
        )
        _timer.daemon = True
        _timer.start()


def stop() -> None:
    """Stop the periodic cleanup (used at app shutdown)."""
    global _timer, _stopped
    with _lock:
        _stopped = True
        if _timer is not None:
            _timer.cancel()
            _timer = None

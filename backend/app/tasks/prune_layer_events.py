"""Daily sweep that prunes old map-layer usage telemetry.

The TOPS map "Advanced Layers" telemetry (``layer.*`` rows, category
``map_layer`` in ``usage_events``) is only needed for the recent-window
admin dashboards. This task deletes those rows once they age past
:data:`RETENTION_DAYS` so the fact table doesn't grow without bound. Only
map-layer rows are touched — every other ``usage_events`` category is left
intact.

Runs on a single in-process timer thread that re-arms after each sweep,
gated by leader election so only one instance prunes in a multi-replica
deployment. Idempotent — re-running deletes nothing once the tail is gone.
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

from ..core import database as db


logger = logging.getLogger("uvicorn.error")

# How long a map-layer telemetry row is retained before pruning.
RETENTION_DAYS = 180
# Re-arm interval for the sweeper (once per day).
PRUNE_INTERVAL_SECONDS = 24 * 60 * 60
# Cap rows deleted per sweep so a huge backlog is drained gradually without
# holding a long transaction.
_DELETE_BATCH = 5000

_lock = threading.Lock()
_timer: Optional[threading.Timer] = None
_stopped = False


def _sweep_once() -> dict:
    """Delete map-layer rows older than the retention window. Returns counts."""
    if not db.is_available():
        return {"deleted": 0}
    deleted = 0
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """DELETE FROM usage_events
                            WHERE ctid IN (
                                SELECT ctid FROM usage_events
                                 WHERE category = 'map_layer'
                                   AND created_at < now() - make_interval(days => %s)
                                 LIMIT %s
                            )""",
                    (RETENTION_DAYS, _DELETE_BATCH),
                )
                deleted = cur.rowcount or 0
    except Exception:
        logger.exception("prune_layer_events: sweep failed")
    return {"deleted": deleted}


def run_now() -> dict:
    """Synchronous entry point — runs one sweep and returns counts."""
    return _sweep_once()


def _scheduled_run() -> None:
    global _timer
    try:
        from ..core import leader_election
        if not leader_election.should_run_scheduled_jobs():
            logger.debug("prune_layer_events: skipping tick — not leader")
        else:
            result = _sweep_once()
            if result.get("deleted"):
                logger.info("prune_layer_events: pruned %s", result)
    except Exception:
        logger.exception("prune_layer_events: sweep raised; will retry next interval")
    finally:
        with _lock:
            if _stopped:
                return
            _timer = threading.Timer(PRUNE_INTERVAL_SECONDS, _scheduled_run)
            _timer.daemon = True
            _timer.start()


def start() -> None:
    """Start the periodic prune. Idempotent — safe to call from app startup."""
    global _timer, _stopped
    with _lock:
        if _timer is not None and _timer.is_alive():
            return
        _stopped = False
        _timer = threading.Timer(PRUNE_INTERVAL_SECONDS, _scheduled_run)
        _timer.daemon = True
        _timer.start()


def stop() -> None:
    """Stop the periodic prune (used at app shutdown)."""
    global _timer, _stopped
    with _lock:
        _stopped = True
        if _timer is not None:
            _timer.cancel()
            _timer = None

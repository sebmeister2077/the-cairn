"""Cross-process leader election for scheduled jobs.

The deployment occasionally runs more than one backend instance against
the same Postgres + R2 (e.g. a local map-render dev instance side-by-side
with the production deployment). Scheduled jobs that touch shared R2
keys — most importantly :mod:`backend.app.tasks.weekly_backup` — must
run on at most one instance at a time or they race and clobber each
other's writes.

This module implements a tiny lease-based leader election:

* Each process generates a long-lived ``_token`` (32 random bytes) at
  start-up.
* A background asyncio task wakes every :data:`_REFRESH_INTERVAL_SECONDS`
  and calls :func:`db.acquire_or_refresh_instance_leader`. The SQL is
  written so the lease falls over only when the previous holder's
  ``expires_at`` is in the past — so a healthy leader keeps the lease
  indefinitely while followers get ``False`` back.
* Application code reads :func:`is_leader` (cheap, in-memory) before
  doing leadership-only work.

Configuration:

* ``RUN_SCHEDULED_JOBS=auto`` (default) — compete for leadership; only
  fire scheduled jobs on the leader.
* ``RUN_SCHEDULED_JOBS=always`` — fire scheduled jobs regardless of
  leadership. Useful for legacy single-instance deployments.
* ``RUN_SCHEDULED_JOBS=never`` — never fire scheduled jobs. Useful for
  the local map-render instance that shouldn't touch shared R2 keys.

A "never" instance skips leader election entirely, so it never becomes
leader and never blocks the production instance.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import socket
from typing import Optional

from ..config import settings
from . import database as db


logger = logging.getLogger("uvicorn.error")


# How often the background loop tries to refresh/claim the lease.
# The DB lease TTL (db.INSTANCE_LEADER_TTL_SECONDS, default 60s) must be
# comfortably larger than this so a transient blip — slow DB tick, single
# missed refresh — doesn't lose leadership.
_REFRESH_INTERVAL_SECONDS = 15


def _resolve_instance_label() -> str:
    label = (settings.INSTANCE_LABEL or "").strip()
    if label:
        return label[:120]
    hostname = socket.gethostname() or "unknown-host"
    return f"{hostname}:{os.getpid()}"[:120]


def _resolve_mode() -> str:
    """Normalise the RUN_SCHEDULED_JOBS env into ``auto`` / ``always`` / ``never``."""
    raw = (settings.RUN_SCHEDULED_JOBS or "auto").strip().lower()
    if raw in {"auto", "always", "never"}:
        return raw
    logger.warning(
        "leader_election: unknown RUN_SCHEDULED_JOBS=%r, falling back to 'auto'", raw
    )
    return "auto"


class _State:
    token: str = ""
    instance_label: str = ""
    mode: str = "auto"
    is_leader: bool = False
    task: Optional[asyncio.Task] = None
    started: bool = False
    stop_event: Optional[asyncio.Event] = None


_state = _State()


def is_leader() -> bool:
    """Fast in-memory check. ``mode=always`` returns True unconditionally;
    ``mode=never`` returns False unconditionally; ``mode=auto`` reflects
    the latest refresh result."""
    if _state.mode == "always":
        return True
    if _state.mode == "never":
        return False
    return _state.is_leader


def should_run_scheduled_jobs() -> bool:
    """Convenience predicate: alias for :func:`is_leader` that scheduled-job
    code can call to make intent explicit at the call site."""
    return is_leader()


def current_info() -> dict:
    """Diagnostic snapshot, intended for admin endpoints / startup logs."""
    return {
        "mode": _state.mode,
        "is_leader": _state.is_leader if _state.mode == "auto" else (_state.mode == "always"),
        "instance_label": _state.instance_label,
        "started": _state.started,
    }


async def _refresh_loop() -> None:
    """Periodic lease refresh. Runs until ``stop_event`` is set."""
    assert _state.stop_event is not None
    # Try to acquire immediately so the first ``is_leader()`` read after
    # startup reflects reality rather than the default False.
    await _refresh_once()
    while not _state.stop_event.is_set():
        try:
            await asyncio.wait_for(
                _state.stop_event.wait(), timeout=_REFRESH_INTERVAL_SECONDS
            )
        except asyncio.TimeoutError:
            pass  # normal — next tick
        if _state.stop_event.is_set():
            break
        await _refresh_once()


async def _refresh_once() -> None:
    try:
        held = await asyncio.to_thread(
            db.acquire_or_refresh_instance_leader,
            _state.token,
            _state.instance_label,
        )
    except Exception:
        # DB blip — keep the previous answer but log loudly.
        logger.exception("leader_election: refresh failed")
        return
    if held and not _state.is_leader:
        logger.info(
            "leader_election: instance %s acquired leadership", _state.instance_label
        )
    elif (not held) and _state.is_leader:
        logger.warning(
            "leader_election: instance %s lost leadership", _state.instance_label
        )
    _state.is_leader = held


def start() -> None:
    """Initialise the in-process state and start the background refresh task.

    Safe to call multiple times (idempotent under uvicorn ``--reload``).
    No-op when ``RUN_SCHEDULED_JOBS=never``.
    """
    if _state.started:
        return
    _state.mode = _resolve_mode()
    _state.instance_label = _resolve_instance_label()
    _state.token = secrets.token_hex(16)
    _state.started = True
    if _state.mode == "never":
        logger.info(
            "leader_election: mode=never (instance %s will not run scheduled jobs)",
            _state.instance_label,
        )
        return
    if _state.mode == "always":
        logger.info(
            "leader_election: mode=always (instance %s will run scheduled jobs unconditionally)",
            _state.instance_label,
        )
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No running loop yet — called outside the lifespan. Caller will
        # retry from inside the lifespan; bail without scheduling.
        logger.warning("leader_election: start() called outside a running loop")
        _state.started = False
        return
    _state.stop_event = asyncio.Event()
    _state.task = loop.create_task(_refresh_loop(), name="leader_election_refresh")
    logger.info(
        "leader_election: mode=auto (instance %s competing for leadership, refresh every %ds)",
        _state.instance_label, _REFRESH_INTERVAL_SECONDS,
    )


async def stop() -> None:
    """Cancel the refresh task and voluntarily release the lease so the
    other instance can take over immediately instead of waiting for the
    TTL. Safe to call when ``start()`` was never invoked."""
    if not _state.started:
        return
    if _state.stop_event is not None:
        _state.stop_event.set()
    task = _state.task
    if task is not None:
        try:
            await asyncio.wait_for(task, timeout=5.0)
        except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
            task.cancel()
    if _state.mode == "auto" and _state.is_leader:
        try:
            await asyncio.to_thread(db.release_instance_leader, _state.token)
            logger.info(
                "leader_election: instance %s released leadership on shutdown",
                _state.instance_label,
            )
        except Exception:
            logger.exception("leader_election: failed to release lease on shutdown")
    _state.is_leader = False
    _state.task = None
    _state.stop_event = None
    _state.started = False

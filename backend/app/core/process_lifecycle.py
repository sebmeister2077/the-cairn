"""Durable process-lifecycle / crash recorder.

Writes one row per process start into ``process_lifecycle`` and keeps it
fresh with a heartbeat, so that an *ungraceful* death — an OOM / SIGKILL, a
native segfault, or any hard crash that by definition cannot be caught
in-process — is still recorded. The mechanism is reconciliation on the next
boot: a graceful stop marks its own row ``stopped_clean``; anything else
leaves the row ``running``, and the next boot of the same replica flips it to
``crashed_ungraceful`` with the dead process's last heartbeat and peak RSS.
That peak-RSS figure right before a silent disappearance is the fingerprint
of an OOM kill (see the note in :func:`app.main._install_crash_diagnostics`).

Best-effort throughout: every database touch is wrapped so a DB outage can
never take the app down or block startup/shutdown. If the table is missing or
the database is unreachable the recorder quietly disables itself.

Status values written to ``process_lifecycle.status``:
  * ``running``             — process is alive (heartbeat refreshes it).
  * ``stopped_clean``       — graceful shutdown (lifespan finally ran).
  * ``crashed_exception``   — an unhandled exception reached the interpreter
                              excepthook (main or worker thread).
  * ``crashed_ungraceful``  — no shutdown record at all; reconciled by a
                              later boot. The classic OOM/SIGKILL signature.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import socket
import threading
import traceback
import uuid
from typing import Optional

from ..config import settings
from . import database as db


logger = logging.getLogger("uvicorn.error")

# How often the background thread refreshes ``last_heartbeat_at`` / RSS. A
# healthy process writes well within the reconcile threshold below, so a
# stale heartbeat is an unambiguous "this process is dead" signal.
_HEARTBEAT_INTERVAL_SECONDS = 15
# A ``running`` row whose heartbeat is older than this is considered dead
# during reconciliation even if its replica id does not match ours (covers
# platforms that hand a fresh hostname to a restarted container).
_STALE_HEARTBEAT_SECONDS = 300
# Cap on retained history — pruned on each boot.
_MAX_ROWS = 500

_boot_id: Optional[str] = None
_replica: Optional[str] = None
_enabled = False
_shutdown_recorded = False
_shutdown_reason: Optional[str] = None
_rss_peak_mb = 0

_stop_event = threading.Event()
_heartbeat_thread: Optional[threading.Thread] = None
_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Identity + memory helpers
# ---------------------------------------------------------------------------
def _resolve_replica() -> str:
    """Stable per-instance identity used to reconcile a dead predecessor.

    Prefers the platform replica id (Railway), then the configured instance
    label, then ``hostname``. Kept distinct from the PID so a restarted
    container maps back to the same ``replica`` and its orphaned ``running``
    row can be reconciled.
    """
    for env_key in ("RAILWAY_REPLICA_ID", "RENDER_INSTANCE_ID", "HOSTNAME_OVERRIDE"):
        val = (os.environ.get(env_key) or "").strip()
        if val:
            return val[:120]
    label = (getattr(settings, "INSTANCE_LABEL", "") or "").strip()
    if label:
        return label[:120]
    return (socket.gethostname() or "unknown-host")[:120]


def _read_rss_mb() -> Optional[int]:
    """Resident-set size in MiB. psutil first, then Linux ``/proc``, then
    ``resource`` — never raises."""
    try:
        import psutil  # preferred: accurate + cross-platform

        return int(psutil.Process().memory_info().rss / (1024 * 1024))
    except Exception:
        pass
    try:
        with open("/proc/self/status", "r", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    return int(int(line.split()[1]) / 1024)  # kB -> MiB
    except Exception:
        pass
    try:
        import resource

        ru = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # Linux reports kB, macOS/BSD report bytes.
        return int(ru / 1024) if ru < 10_000_000 else int(ru / (1024 * 1024))
    except Exception:
        return None


def _track_peak(rss: Optional[int]) -> int:
    global _rss_peak_mb
    if rss and rss > _rss_peak_mb:
        _rss_peak_mb = rss
    return _rss_peak_mb


# ---------------------------------------------------------------------------
# Schema safety net (idempotent) — guarantees the table exists even on the
# legacy ``ensure_schema`` path where new DDL is no longer added.
# ---------------------------------------------------------------------------
_DDL = """
CREATE TABLE IF NOT EXISTS process_lifecycle (
    id              BIGSERIAL PRIMARY KEY,
    boot_id         TEXT NOT NULL,
    replica         TEXT,
    instance_label  TEXT,
    pid             INTEGER,
    app_env         TEXT,
    status          TEXT NOT NULL DEFAULT 'running',
    reason          TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_heartbeat_at TIMESTAMPTZ,
    stopped_at      TIMESTAMPTZ,
    rss_mb          INTEGER,
    rss_mb_peak     INTEGER,
    detail          JSONB,
    CONSTRAINT uq_process_lifecycle_boot_id UNIQUE (boot_id)
);
CREATE INDEX IF NOT EXISTS idx_process_lifecycle_started
    ON process_lifecycle (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_process_lifecycle_replica_status
    ON process_lifecycle (replica, status);
"""


def _ensure_table() -> None:
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(_DDL)


# ---------------------------------------------------------------------------
# Lifecycle entry points
# ---------------------------------------------------------------------------
def on_startup() -> None:
    """Reconcile the previous process's crash, insert this boot's row, start
    the heartbeat thread, and install exception/signal hooks.

    Call once during application startup, after the schema is in place.
    Best-effort: a database outage simply disables the recorder for this run.
    """
    global _boot_id, _replica, _enabled, _shutdown_recorded, _rss_peak_mb

    if _enabled:
        return
    _boot_id = uuid.uuid4().hex
    _replica = _resolve_replica()
    _shutdown_recorded = False
    rss = _read_rss_mb()
    _rss_peak_mb = rss or 0

    if not db.is_available():
        logger.warning(
            "process_lifecycle: database unavailable at startup — crash "
            "recording disabled for this run."
        )
        return

    try:
        _ensure_table()
    except Exception as exc:  # pragma: no cover — must not block startup
        logger.warning("process_lifecycle: could not ensure table (%s) — disabled.", exc)
        return

    crashed = _reconcile_orphans()
    if crashed:
        logger.error(
            "process_lifecycle: detected %d process(es) that died without a "
            "graceful shutdown (likely OOM/SIGKILL) — recorded as "
            "crashed_ungraceful.",
            crashed,
        )

    try:
        detail = {
            "replica": _replica,
            "instance_label": (getattr(settings, "INSTANCE_LABEL", "") or "") or None,
            "hostname": socket.gethostname(),
        }
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO process_lifecycle
                            (boot_id, replica, instance_label, pid, app_env,
                             status, started_at, last_heartbeat_at,
                             rss_mb, rss_mb_peak, detail)
                       VALUES (%s, %s, %s, %s, %s, 'running', now(), now(),
                               %s, %s, %s)""",
                    (
                        _boot_id,
                        _replica,
                        detail["instance_label"],
                        os.getpid(),
                        getattr(settings, "APP_ENV", None),
                        rss,
                        rss,
                        json.dumps(detail),
                    ),
                )
    except Exception as exc:  # pragma: no cover
        logger.warning("process_lifecycle: boot insert failed (%s) — disabled.", exc)
        return

    _enabled = True
    _prune_history()
    _install_excepthooks()
    _install_signal_handlers()
    _start_heartbeat()
    logger.info(
        "process_lifecycle: boot recorded (boot_id=%s replica=%s pid=%d rss=%sMB).",
        _boot_id, _replica, os.getpid(), rss,
    )


def on_shutdown(reason: Optional[str] = None, status: str = "stopped_clean") -> None:
    """Mark this boot's row as cleanly stopped. Call from the lifespan
    ``finally`` block (before :func:`database.close_db`). Idempotent."""
    global _shutdown_recorded
    _stop_heartbeat()
    if not _enabled or _shutdown_recorded or not _boot_id:
        return
    final_reason = reason or _shutdown_reason or "graceful shutdown"
    rss = _read_rss_mb()
    peak = _track_peak(rss)
    try:
        if not db.is_available():
            return
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """UPDATE process_lifecycle
                          SET status = %s,
                              reason = %s,
                              stopped_at = now(),
                              last_heartbeat_at = now(),
                              rss_mb = %s,
                              rss_mb_peak = GREATEST(COALESCE(rss_mb_peak, 0), %s)
                        WHERE boot_id = %s""",
                    (status, final_reason, rss, peak, _boot_id),
                )
        _shutdown_recorded = True
        logger.info(
            "process_lifecycle: shutdown recorded (status=%s reason=%s rss=%sMB peak=%sMB).",
            status, final_reason, rss, peak,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("process_lifecycle: shutdown update failed: %s", exc)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------
def _reconcile_orphans() -> int:
    """Flip any ``running`` row left behind by a dead predecessor to
    ``crashed_ungraceful``. Matches our own replica (the normal restart case)
    or any row whose heartbeat is badly stale (covers a changed hostname), so
    a healthy sibling on a *different* replica with a fresh heartbeat is never
    touched.

    Assumes one process per replica (the current deployment runs a single
    uvicorn worker — see ``backend/render.yaml``, no ``--workers``). If the
    service is ever scaled to multiple uvicorn workers per replica, the
    ``replica = %s`` branch would flip a healthy sibling worker's fresh row;
    at that point switch it to also require a stale heartbeat, or add a
    per-worker identity column.
    """
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""UPDATE process_lifecycle
                           SET status = 'crashed_ungraceful',
                               stopped_at = now(),
                               reason = COALESCE(reason,
                                   'process disappeared without a graceful '
                                   'shutdown (likely OOM/SIGKILL or native crash)')
                         WHERE status = 'running'
                           AND boot_id <> %s
                           AND (
                                 replica = %s
                              OR last_heartbeat_at < now() - interval '{_STALE_HEARTBEAT_SECONDS} seconds'
                              OR (last_heartbeat_at IS NULL
                                  AND started_at < now() - interval '{_STALE_HEARTBEAT_SECONDS} seconds')
                           )""",
                    (_boot_id, _replica),
                )
                return cur.rowcount or 0
    except Exception as exc:  # pragma: no cover
        logger.warning("process_lifecycle: reconcile failed: %s", exc)
        return 0


def _prune_history() -> None:
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """DELETE FROM process_lifecycle
                        WHERE id NOT IN (
                            SELECT id FROM process_lifecycle
                             ORDER BY id DESC LIMIT %s
                        )""",
                    (_MAX_ROWS,),
                )
    except Exception as exc:  # pragma: no cover
        logger.warning("process_lifecycle: prune failed: %s", exc)


def _write_heartbeat() -> None:
    if not _enabled or not _boot_id:
        return
    rss = _read_rss_mb()
    peak = _track_peak(rss)
    try:
        if not db.is_available():
            return
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """UPDATE process_lifecycle
                          SET last_heartbeat_at = now(),
                              rss_mb = %s,
                              rss_mb_peak = GREATEST(COALESCE(rss_mb_peak, 0), %s)
                        WHERE boot_id = %s AND status = 'running'""",
                    (rss, peak, _boot_id),
                )
    except Exception as exc:  # pragma: no cover — heartbeat must never crash
        logger.debug("process_lifecycle: heartbeat failed: %s", exc)


def _heartbeat_loop() -> None:
    while not _stop_event.wait(_HEARTBEAT_INTERVAL_SECONDS):
        _write_heartbeat()


def _start_heartbeat() -> None:
    global _heartbeat_thread
    if _heartbeat_thread is not None:
        return
    _stop_event.clear()
    _heartbeat_thread = threading.Thread(
        target=_heartbeat_loop,
        name="process-lifecycle-heartbeat",
        daemon=True,
    )
    _heartbeat_thread.start()


def _stop_heartbeat() -> None:
    global _heartbeat_thread
    _stop_event.set()
    thread = _heartbeat_thread
    if thread is not None and thread.is_alive() and thread is not threading.current_thread():
        thread.join(timeout=2.0)
    _heartbeat_thread = None


def _record_crash_exception(exc_type, exc_value, exc_tb, thread_name: str = "") -> None:
    """Persist an unhandled exception as ``crashed_exception``. Never raises."""
    global _shutdown_recorded
    if not _enabled or not _boot_id:
        return
    try:
        tb_tail = "".join(
            traceback.format_exception(exc_type, exc_value, exc_tb)
        )[-4000:]
        reason = f"unhandled {getattr(exc_type, '__name__', exc_type)}: {exc_value}"[:500]
        detail = {
            "exc_type": getattr(exc_type, "__name__", str(exc_type)),
            "thread": thread_name or threading.current_thread().name,
            "traceback_tail": tb_tail,
            "rss_mb": _read_rss_mb(),
            "rss_mb_peak": _rss_peak_mb,
        }
        with _lock:
            if not db.is_available():
                return
            with db.get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """UPDATE process_lifecycle
                              SET status = 'crashed_exception',
                                  reason = %s,
                                  stopped_at = now(),
                                  detail = COALESCE(detail, '{}'::jsonb) || %s::jsonb
                            WHERE boot_id = %s""",
                        (reason, json.dumps(detail), _boot_id),
                    )
            _shutdown_recorded = True
    except Exception:  # pragma: no cover — excepthook must never raise
        pass


def _install_excepthooks() -> None:
    import sys

    prev_sys_hook = sys.excepthook

    def sys_hook(exc_type, exc_value, exc_tb):
        _record_crash_exception(exc_type, exc_value, exc_tb, thread_name="MainThread")
        prev_sys_hook(exc_type, exc_value, exc_tb)

    sys.excepthook = sys_hook

    prev_thread_hook = getattr(threading, "excepthook", None)

    def thread_hook(args):
        _record_crash_exception(
            args.exc_type,
            args.exc_value,
            args.exc_traceback,
            thread_name=getattr(args.thread, "name", "") or "",
        )
        if callable(prev_thread_hook):
            prev_thread_hook(args)

    if prev_thread_hook is not None:
        threading.excepthook = thread_hook


def _install_signal_handlers() -> None:
    """Capture SIGTERM/SIGINT so the recorded shutdown reason distinguishes a
    platform stop (deploy / scale-down) from a programmatic one. Chains to the
    previously installed handler (uvicorn's) so graceful shutdown is
    unaffected. Only works from the main thread; failures are swallowed."""
    def make_handler(prev_handler, sig_name):
        def handler(signum, frame):
            global _shutdown_reason
            _shutdown_reason = f"received {sig_name} (platform stop / deploy / scale-down)"
            if callable(prev_handler):
                prev_handler(signum, frame)
        return handler

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            prev = signal.getsignal(sig)
            # Only wrap an existing callable handler (uvicorn installs its own
            # before lifespan startup). If the slot is SIG_DFL / SIG_IGN, leave
            # it untouched so default termination / Ctrl+C semantics are
            # preserved.
            if not callable(prev):
                continue
            signal.signal(sig, make_handler(prev, sig.name))
        except Exception:  # pragma: no cover — non-main thread / unsupported
            continue

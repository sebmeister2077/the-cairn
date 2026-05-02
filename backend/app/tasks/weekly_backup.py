"""Phase 4a — weekly snapshots of the combined map .db.

A background timer wakes up every ``BACKUP_CHECK_INTERVAL_SECONDS`` and, if
the current ISO calendar week has no scheduled snapshot in R2 yet, copies
``globalservermap.db`` to ``backups/backup-YYYY-Www.db`` using R2's
server-side ``copy_object`` (no download — atomic and free).

Cleanup runs in the same loop:
  * keep the ``BACKUP_KEEP_SCHEDULED`` newest scheduled snapshots
  * keep the ``BACKUP_KEEP_MANUAL``   newest manual snapshots

Naming convention:
  scheduled : ``backups/backup-YYYY-Www.db``
  manual    : ``backups/backup-YYYY-Www-manual-<unix_timestamp>.db``

Both are gated by the ``weekly_backups`` feature flag — when off, the
scheduler still ticks but neither creates nor deletes anything.
"""

from __future__ import annotations

import logging
import re
import threading
from datetime import datetime, timezone
from typing import List, Optional

from ..config import settings
from ..core import database as db
from ..core import feature_flags as ff
from ..core import r2_storage


logger = logging.getLogger("uvicorn.error")

_lock = threading.Lock()
_timer: Optional[threading.Timer] = None
_stopped = False

# backup-2026-W17.db   OR   backup-2026-W17-manual-1714214400.db
_RE_SCHEDULED = re.compile(r"^backups/backup-(\d{4})-W(\d{2})\.db$")
_RE_MANUAL = re.compile(r"^backups/backup-(\d{4})-W(\d{2})-manual-(\d+)\.db$")


def _now_iso_week() -> tuple:
    iso = datetime.now(timezone.utc).isocalendar()
    return int(iso[0]), int(iso[1])


def _classify(key: str) -> Optional[str]:
    if _RE_SCHEDULED.match(key):
        return "scheduled"
    if _RE_MANUAL.match(key):
        return "manual"
    return None


def list_backups() -> List[dict]:
    """Return all backup objects with kind + ISO label, newest first."""
    out = []
    for obj in r2_storage.list_backup_objects():
        kind = _classify(obj["key"])
        if kind is None:
            continue
        lm = obj.get("last_modified")
        out.append(
            {
                "key": obj["key"],
                "kind": kind,
                "size": obj["size"],
                "last_modified": lm.isoformat() if lm else None,
            }
        )
    out.sort(key=lambda r: r["last_modified"] or "", reverse=True)
    return out


def create_scheduled_snapshot_if_due() -> Optional[str]:
    """Create this week's scheduled snapshot if it doesn't exist yet.

    Returns the new R2 key on creation, or ``None`` if a snapshot for the
    current ISO week already exists (idempotent re-runs in the same week).

    Holds the global map lock for the duration of the copy so an approve or
    revert cannot overwrite the source partway through a multipart copy.
    """
    iso_year, iso_week = _now_iso_week()
    target_key = r2_storage.backup_scheduled_key(iso_year, iso_week)
    if r2_storage.object_exists(target_key):
        return None
    if not r2_storage.object_exists(r2_storage.COMBINED_DB_KEY):
        logger.info("weekly_backup: combined .db missing — skipping snapshot")
        return None
    try:
        with db.with_map_lock("backup"):
            r2_storage.copy_object(r2_storage.COMBINED_DB_KEY, target_key)
    except db.MapLocked:
        logger.info(
            "weekly_backup: skipping scheduled snapshot — map lock held by "
            "another operation; will retry on next tick"
        )
        return None
    logger.info("weekly_backup: created scheduled snapshot %s", target_key)
    return target_key


def create_manual_snapshot() -> str:
    """Force-create a manual snapshot tagged with the current unix timestamp.

    The caller is expected to already hold the global map lock (the admin
    route does this) so an approve/revert cannot race the multipart copy.
    """
    iso_year, iso_week = _now_iso_week()
    ts = int(datetime.now(timezone.utc).timestamp())
    target_key = r2_storage.backup_manual_key(iso_year, iso_week, ts)
    if not r2_storage.object_exists(r2_storage.COMBINED_DB_KEY):
        raise FileNotFoundError("Combined map .db is not present in R2")
    r2_storage.copy_object(r2_storage.COMBINED_DB_KEY, target_key)
    logger.info("weekly_backup: created manual snapshot %s", target_key)
    return target_key


def cleanup_old_backups() -> dict:
    """Trim each backup kind to its configured retention. Returns counts."""
    backups = list_backups()
    scheduled = [b for b in backups if b["kind"] == "scheduled"]
    manual = [b for b in backups if b["kind"] == "manual"]

    to_delete: List[str] = []
    if settings.BACKUP_KEEP_SCHEDULED >= 0:
        to_delete.extend(b["key"] for b in scheduled[settings.BACKUP_KEEP_SCHEDULED:])
    if settings.BACKUP_KEEP_MANUAL >= 0:
        to_delete.extend(b["key"] for b in manual[settings.BACKUP_KEEP_MANUAL:])

    if to_delete:
        r2_storage.delete_keys(to_delete)
        logger.info("weekly_backup: deleted %d old snapshots", len(to_delete))
    return {"deleted": len(to_delete)}


def run_now() -> dict:
    """Synchronous: snapshot if due + run cleanup. Returns a small report."""
    created = None
    if ff.is_feature_enabled("weekly_backups"):
        try:
            created = create_scheduled_snapshot_if_due()
        except Exception:
            logger.exception("weekly_backup: snapshot failed")
    cleanup = cleanup_old_backups() if ff.is_feature_enabled("weekly_backups") else {"deleted": 0}
    return {"created": created, "cleanup": cleanup}


def _scheduled_run() -> None:
    global _timer
    try:
        result = run_now()
        if result.get("created") or result["cleanup"]["deleted"]:
            logger.info("weekly_backup: tick %s", result)
    except Exception:
        logger.exception("weekly_backup: scheduled run failed")
    finally:
        with _lock:
            if _stopped:
                return
            _timer = threading.Timer(
                settings.BACKUP_CHECK_INTERVAL_SECONDS, _scheduled_run
            )
            _timer.daemon = True
            _timer.start()


def start() -> None:
    """Start the periodic backup checker. Idempotent."""
    global _timer, _stopped
    with _lock:
        if _timer is not None and _timer.is_alive():
            return
        _stopped = False
        _timer = threading.Timer(
            settings.BACKUP_CHECK_INTERVAL_SECONDS, _scheduled_run
        )
        _timer.daemon = True
        _timer.start()


def stop() -> None:
    global _timer, _stopped
    with _lock:
        _stopped = True
        if _timer is not None:
            _timer.cancel()
            _timer = None

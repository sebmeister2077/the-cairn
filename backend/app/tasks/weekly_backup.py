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
from datetime import datetime, timedelta, timezone
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
_RE_SCHEDULED = re.compile(r"^backups/backup-(\d{4})-W(\d{2})\.db(?:\.zst)?$")
_RE_MANUAL = re.compile(r"^backups/backup-(\d{4})-W(\d{2})-manual-(\d+)\.db(?:\.zst)?$")

# landmarks-2026-W17.geojson   |   landmarks-2026-W17-manual-<ts>.geojson
# (and the same for translocators-)
_RE_GEOJSON_SCHEDULED = re.compile(
    r"^backups/(landmarks|translocators|traders)-(\d{4})-W(\d{2})\.geojson$"
)
_RE_GEOJSON_MANUAL = re.compile(
    r"^backups/(landmarks|translocators|traders)-(\d{4})-W(\d{2})-manual-(\d+)\.geojson$"
)


def _now_iso_week() -> tuple:
    iso = datetime.now(timezone.utc).isocalendar()
    return int(iso[0]), int(iso[1])


# ---------------------------------------------------------------------------
# Per-category backup schedule (traders / map-features-traders / elk-walkable)
# ---------------------------------------------------------------------------
#
# Admins tune how often each of these three categories gets a scheduled
# snapshot — or disable it entirely — from the Audit → Backups page. The
# config lives under the ``category_backup_schedule`` app_settings key, e.g.
# ``{"traders": "weekly", "map_features_traders": "biweekly",
#    "elk_walkable": "disabled"}``.
#
# landmarks + translocators are intentionally NOT configurable here — they
# keep their original always-weekly cadence.

_BACKUP_SCHEDULE_KEY = "category_backup_schedule"
BACKUP_SCHEDULE_CATEGORIES = (
    "traders",
    "map_features_traders",
    "elk_walkable",
    "map_features_rapids",
    "tops_translocators",
)
BACKUP_SCHEDULE_INTERVALS = ("weekly", "biweekly", "monthly", "disabled")
_BACKUP_SCHEDULE_DEFAULT = "weekly"
_INTERVAL_DAYS = {"weekly": 7, "biweekly": 14, "monthly": 30}


def _normalise_backup_schedule(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for cat in BACKUP_SCHEDULE_CATEGORIES:
        val = raw.get(cat)
        out[cat] = val if val in BACKUP_SCHEDULE_INTERVALS else _BACKUP_SCHEDULE_DEFAULT
    return out


def get_backup_schedule() -> dict:
    """Return the normalised per-category schedule dict (always complete)."""
    try:
        row = db.get_app_setting(_BACKUP_SCHEDULE_KEY)
    except Exception:
        logger.exception("weekly_backup: failed to read backup schedule")
        row = None
    return _normalise_backup_schedule(row["value"] if row else None)


def set_backup_schedule(patch: dict, updated_by_key: str = "") -> dict:
    """Merge ``patch`` into the stored schedule (ignoring unknown keys/values)
    and persist it. Returns the resulting normalised dict."""
    current = get_backup_schedule()
    for cat, val in (patch or {}).items():
        if cat in BACKUP_SCHEDULE_CATEGORIES and val in BACKUP_SCHEDULE_INTERVALS:
            current[cat] = val
    db.set_app_setting(_BACKUP_SCHEDULE_KEY, current, updated_by_key=updated_by_key)
    return current


def _parse_iso(dt_str: Optional[str]) -> Optional[datetime]:
    if not dt_str:
        return None
    try:
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _interval_due(category: str, last_modified: Optional[datetime]) -> bool:
    """True if ``category`` is due for a scheduled snapshot given the timestamp
    of its newest existing backup (or None when it has none)."""
    schedule = get_backup_schedule().get(category, _BACKUP_SCHEDULE_DEFAULT)
    if schedule == "disabled":
        return False
    days = _INTERVAL_DAYS.get(schedule, 7)
    if last_modified is None:
        return True
    now = datetime.now(timezone.utc)
    if last_modified.tzinfo is None:
        last_modified = last_modified.replace(tzinfo=timezone.utc)
    # 12-hour tolerance so a tick that lands slightly early still fires.
    return (now - last_modified) >= (timedelta(days=days) - timedelta(hours=12))


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


def _compress_artefacts_enabled() -> bool:
    try:
        return ff.is_feature_enabled("compress_artefacts")
    except Exception:
        return False


def _snapshot_combined_to(target_raw_key: str) -> str:
    """Materialise a backup of ``COMBINED_DB_KEY`` at ``target_raw_key``.

    Honours the ``compress_artefacts`` flag:

    * OFF → the historical zero-egress server-side ``copy_object``. Returns
      the raw key.
    * ON  → downloads the combined DB to a temp, streams it through zstd
      with the current admin settings, and uploads to ``target_raw_key + .zst``.
      Returns the .zst key.

    Caller is expected to hold the global map lock.
    """
    import os
    import tempfile
    if not _compress_artefacts_enabled():
        r2_storage.copy_object(r2_storage.COMBINED_DB_KEY, target_raw_key)
        return target_raw_key

    target_zst_key = target_raw_key + ".zst"

    # Fast path: if the background combined-DB compressor has already
    # produced ``globalservermap.db.zst`` from the *current* raw bytes
    # (its ``source-etag`` user-metadata matches the live raw ETag),
    # snapshot it with a zero-egress server-side copy. This avoids
    # downloading the multi-GB raw DB onto the small Render persistent
    # disk just to recompress it — which is what was OOMing the disk
    # on production.
    try:
        raw_etag = r2_storage.get_object_etag(r2_storage.COMBINED_DB_KEY)
        zst_meta = r2_storage.head_object_metadata(r2_storage.COMBINED_DB_ZSTD_KEY)
        if raw_etag and (zst_meta.get("source-etag") or "") == raw_etag:
            r2_storage.copy_object(r2_storage.COMBINED_DB_ZSTD_KEY, target_zst_key)
            logger.info(
                "weekly_backup: snapshot via server-side copy of live .zst "
                "(source-etag match, raw_etag=%s)", raw_etag[:12],
            )
            return target_zst_key
    except FileNotFoundError:
        # No live .zst sibling yet (background compressor hasn't run, or
        # raw DB missing — the outer caller already checked the raw key
        # exists, so this is the .zst case). Fall through to recompress.
        pass
    except Exception:
        logger.exception(
            "weekly_backup: live-.zst fast path failed — falling back to "
            "download + recompress"
        )

    from ..core import compression as comp
    from ..routes.admin_settings import get_compression_settings
    from ..routes.contribute_r2 import get_combined_db_cached

    sett = get_compression_settings()
    level = int(sett["level"])
    threads = comp.resolve_threads(sett["threads_preset"])

    # Reuse the ETag-cached local copy of the combined DB instead of
    # re-downloading it from R2. ``get_combined_db_cached()`` HEADs the
    # object and only pulls bytes when the remote ETag differs from the
    # locally stored one, so back-to-back snapshots after a merge skip
    # the multi-GB download entirely. The returned path is shared and
    # MUST be treated as read-only (we only read from it for compression).
    fd_out, dst_path = tempfile.mkstemp(suffix=".db.zst")
    os.close(fd_out)
    try:
        src_path = get_combined_db_cached()
        comp.compress_file(src_path, dst_path, level=level, threads=threads)
        r2_storage.upload_file(dst_path, target_zst_key)
        return target_zst_key
    finally:
        try:
            os.unlink(dst_path)
        except OSError:
            pass


def create_scheduled_snapshot_if_due() -> Optional[str]:
    """Create this week's scheduled snapshot if it doesn't exist yet.

    Returns the new R2 key on creation, or ``None`` if a snapshot for the
    current ISO week already exists (idempotent re-runs in the same week).

    Holds the global map lock for the duration of the copy so an approve or
    revert cannot overwrite the source partway through a multipart copy.
    """
    iso_year, iso_week = _now_iso_week()
    target_raw = r2_storage.backup_scheduled_key(iso_year, iso_week)
    # Either form already counts as "this week's snapshot exists".
    if r2_storage.object_exists(target_raw) or r2_storage.object_exists(
        target_raw + ".zst"
    ):
        return None
    if not r2_storage.object_exists(r2_storage.COMBINED_DB_KEY):
        logger.info("weekly_backup: combined .db missing — skipping snapshot")
        return None
    try:
        with db.with_map_lock("backup"):
            target_key = _snapshot_combined_to(target_raw)
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
    target_raw = r2_storage.backup_manual_key(iso_year, iso_week, ts)
    if not r2_storage.object_exists(r2_storage.COMBINED_DB_KEY):
        raise FileNotFoundError("Combined map .db is not present in R2")
    target_key = _snapshot_combined_to(target_raw)
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
    geojson_created: List[str] = []
    mf_traders_created: Optional[str] = None
    elk_created: Optional[str] = None
    mf_rapids_created: Optional[str] = None
    tops_tl_created: Optional[str] = None
    if ff.is_feature_enabled("weekly_backups"):
        try:
            created = create_scheduled_snapshot_if_due()
        except Exception:
            logger.exception("weekly_backup: snapshot failed")
        try:
            geojson_created = create_scheduled_geojson_snapshots_if_due()
        except Exception:
            logger.exception("weekly_backup: geojson snapshot failed")
        try:
            mf_traders_created = create_scheduled_map_features_traders_snapshot_if_due()
        except Exception:
            logger.exception("weekly_backup: map-features traders snapshot failed")
        try:
            elk_created = create_scheduled_elk_walkable_snapshot_if_due()
        except Exception:
            logger.exception("weekly_backup: elk-walkable snapshot failed")
        try:
            mf_rapids_created = create_scheduled_map_features_rapids_snapshot_if_due()
        except Exception:
            logger.exception("weekly_backup: map-features rapids snapshot failed")
        try:
            tops_tl_created = create_scheduled_tops_translocators_snapshot_if_due()
        except Exception:
            logger.exception("weekly_backup: upstream translocators snapshot failed")
    cleanup = cleanup_old_backups() if ff.is_feature_enabled("weekly_backups") else {"deleted": 0}
    geojson_cleanup = (
        cleanup_old_geojson_backups()
        if ff.is_feature_enabled("weekly_backups")
        else {"deleted": 0}
    )
    mf_traders_cleanup = (
        cleanup_old_map_features_traders_backups()
        if ff.is_feature_enabled("weekly_backups")
        else {"deleted": 0}
    )
    mf_rapids_cleanup = (
        cleanup_old_map_features_rapids_backups()
        if ff.is_feature_enabled("weekly_backups")
        else {"deleted": 0}
    )
    tops_tl_cleanup = (
        cleanup_old_tops_translocators_backups()
        if ff.is_feature_enabled("weekly_backups")
        else {"deleted": 0}
    )
    return {
        "created": created,
        "cleanup": cleanup,
        "geojson_created": geojson_created,
        "geojson_cleanup": geojson_cleanup,
        "map_features_traders_created": mf_traders_created,
        "map_features_traders_cleanup": mf_traders_cleanup,
        "elk_walkable_created": elk_created,
        "map_features_rapids_created": mf_rapids_created,
        "map_features_rapids_cleanup": mf_rapids_cleanup,
        "tops_translocators_created": tops_tl_created,
        "tops_translocators_cleanup": tops_tl_cleanup,
    }


def _scheduled_run() -> None:
    global _timer
    try:
        # Multi-instance safety: the snapshot writes to a shared R2 key
        # (``backups/backup-YYYY-Www.db``) so only the elected leader may
        # take this tick. Everyone else just re-arms the timer.
        from ..core import leader_election
        if not leader_election.should_run_scheduled_jobs():
            logger.debug("weekly_backup: skipping tick — not leader")
        else:
            result = run_now()
            if (
                result.get("created")
                or result["cleanup"]["deleted"]
                or result.get("map_features_traders_created")
                or result.get("map_features_rapids_created")
                or result.get("tops_translocators_created")
            ):
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
        # Reclaim storage from any multipart copy that was interrupted by a
        # crash/restart of a previous process. Older than 1h is safely past
        # any in-flight legitimate copy (a 10–20 GB DB copies in seconds).
        try:
            aborted = r2_storage.abort_stale_multipart_uploads(
                r2_storage.BACKUP_KEY_PREFIX, older_than_seconds=3600
            )
            if aborted:
                logger.info(
                    "weekly_backup: aborted %d stale multipart upload(s) at startup",
                    aborted,
                )
        except Exception:
            logger.exception("weekly_backup: stale multipart sweep failed")
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


# ---------------------------------------------------------------------------
# Phase 4 — landmarks + translocators geojson backups
# ---------------------------------------------------------------------------
#
# These run alongside the combined-DB snapshots in the same scheduler tick.
# Storage layout (under ``backups/``):
#   landmarks-YYYY-Www.geojson
#   landmarks-YYYY-Www-manual-<unix>.geojson
#   translocators-YYYY-Www.geojson
#   translocators-YYYY-Www-manual-<unix>.geojson
#
# Each file is whatever bytes were live at the moment the snapshot was taken,
# copied via R2 server-side ``copy_object`` (no download, no compression — the
# files are tiny). Retention reuses ``BACKUP_KEEP_SCHEDULED`` /
# ``BACKUP_KEEP_MANUAL`` and is applied per (kind, asset) pair.

_GEOJSON_ASSETS = (
    ("landmarks", r2_storage.landmarks_live_key,
     r2_storage.landmarks_backup_scheduled_key,
     r2_storage.landmarks_backup_manual_key),
    ("translocators", r2_storage.translocators_live_key,
     r2_storage.translocators_backup_scheduled_key,
     r2_storage.translocators_backup_manual_key),
    ("traders", r2_storage.traders_live_key,
     r2_storage.traders_backup_scheduled_key,
     r2_storage.traders_backup_manual_key),
)


def _classify_geojson(key: str) -> Optional[tuple]:
    """Return (asset, kind) for a backup key, or None if it's not a geojson backup."""
    m = _RE_GEOJSON_SCHEDULED.match(key)
    if m:
        return (m.group(1), "scheduled")
    m = _RE_GEOJSON_MANUAL.match(key)
    if m:
        return (m.group(1), "manual")
    return None


def list_geojson_backups() -> List[dict]:
    """Return all geojson backup objects (landmarks + translocators), newest first."""
    out = []
    for obj in r2_storage.list_backup_objects():
        cls = _classify_geojson(obj["key"])
        if cls is None:
            continue
        asset, kind = cls
        lm = obj.get("last_modified")
        out.append(
            {
                "key": obj["key"],
                "asset": asset,
                "kind": kind,
                "size": obj["size"],
                "last_modified": lm.isoformat() if lm else None,
            }
        )
    out.sort(key=lambda r: r["last_modified"] or "", reverse=True)
    return out


def create_scheduled_geojson_snapshots_if_due() -> List[str]:
    """Create this week's scheduled landmarks + translocators snapshots.

    Idempotent: if a snapshot for the current ISO week already exists for an
    asset, it's skipped. Returns the list of newly-created keys.

    Skips silently when the live source is missing (e.g. migration script
    hasn't been run yet) — the next tick will pick it up once the file appears.
    """
    iso_year, iso_week = _now_iso_week()
    created: List[str] = []
    existing = list_geojson_backups()
    for asset, live_key_fn, sched_key_fn, _manual in _GEOJSON_ASSETS:
        # Configurable categories (currently just ``traders``) honour the
        # admin-set interval / disabled switch; landmarks + translocators
        # keep their original always-weekly cadence.
        if asset in BACKUP_SCHEDULE_CATEGORIES:
            scheduled = [
                b for b in existing if b["asset"] == asset and b["kind"] == "scheduled"
            ]
            newest = _parse_iso(scheduled[0]["last_modified"]) if scheduled else None
            if not _interval_due(asset, newest):
                continue
        live_key = live_key_fn()
        target = sched_key_fn(iso_year, iso_week)
        if r2_storage.object_exists(target):
            continue
        if not r2_storage.object_exists(live_key):
            logger.info(
                "weekly_backup: %s live file missing — skipping snapshot",
                asset,
            )
            continue
        try:
            r2_storage.copy_object(live_key, target)
        except Exception:
            logger.exception("weekly_backup: failed to snapshot %s", asset)
            continue
        created.append(target)
        logger.info("weekly_backup: created scheduled %s snapshot %s", asset, target)
    return created


def create_manual_geojson_snapshot(asset: str) -> str:
    """Force-create a manual snapshot of one geojson asset right now.

    ``asset`` must be ``"landmarks"`` or ``"translocators"``.
    """
    matched = next((row for row in _GEOJSON_ASSETS if row[0] == asset), None)
    if matched is None:
        raise ValueError(f"unknown asset {asset!r}")
    _name, live_key_fn, _sched, manual_key_fn = matched
    live_key = live_key_fn()
    if not r2_storage.object_exists(live_key):
        raise FileNotFoundError(f"{asset} live file is not present in R2")
    iso_year, iso_week = _now_iso_week()
    ts = int(datetime.now(timezone.utc).timestamp())
    target = manual_key_fn(iso_year, iso_week, ts)
    r2_storage.copy_object(live_key, target)
    logger.info("weekly_backup: created manual %s snapshot %s", asset, target)
    return target


def cleanup_old_geojson_backups() -> dict:
    """Trim each (asset, kind) pair to its configured retention."""
    backups = list_geojson_backups()
    to_delete: List[str] = []
    for asset, _live, _sched, _manual in _GEOJSON_ASSETS:
        scheduled = [b for b in backups if b["asset"] == asset and b["kind"] == "scheduled"]
        manual = [b for b in backups if b["asset"] == asset and b["kind"] == "manual"]
        if settings.BACKUP_KEEP_SCHEDULED >= 0:
            to_delete.extend(b["key"] for b in scheduled[settings.BACKUP_KEEP_SCHEDULED:])
        if settings.BACKUP_KEEP_MANUAL >= 0:
            to_delete.extend(b["key"] for b in manual[settings.BACKUP_KEEP_MANUAL:])
    if to_delete:
        r2_storage.delete_keys(to_delete)
        logger.info("weekly_backup: deleted %d old geojson snapshots", len(to_delete))
    return {"deleted": len(to_delete)}


def restore_geojson_from_backup(asset: str, backup_key: str) -> str:
    """Copy a backup geojson back over the live key. Returns the live key."""
    matched = next((row for row in _GEOJSON_ASSETS if row[0] == asset), None)
    if matched is None:
        raise ValueError(f"unknown asset {asset!r}")
    _name, live_key_fn, _sched, _manual = matched
    if not r2_storage.object_exists(backup_key):
        raise FileNotFoundError(f"backup not found: {backup_key}")
    cls = _classify_geojson(backup_key)
    if cls is None or cls[0] != asset:
        raise ValueError(f"backup key {backup_key!r} does not match asset {asset!r}")
    live_key = live_key_fn()
    r2_storage.copy_object(backup_key, live_key)
    r2_storage.invalidate_presigned_download_url(live_key)
    logger.info("weekly_backup: restored %s from %s", asset, backup_key)
    return live_key


# ---------------------------------------------------------------------------
# Merged public map-features traders list — biweekly snapshots
# ---------------------------------------------------------------------------
#
# The crowd-sourced ``map-features.traders.json`` (rebuilt from every
# /contribute-map-features upload and published to the PUBLIC map-features
# bucket) is snapshotted once every two weeks into ``backups/``. Unlike the
# geojson assets above there is no restore path — the merged data is
# authoritative and only ever grows from contributor uploads.
#
# Storage layout (under ``backups/``):
#   map-features-traders-YYYY-Www.json
#   map-features-traders-YYYY-Www-manual-<unix>.json
#
# Cadence: scheduled snapshots are taken only on EVEN ISO weeks, giving one
# snapshot roughly every two weeks (idempotent per ISO week).

_RE_MF_TRADERS_SCHEDULED = re.compile(
    r"^backups/map-features-traders-(\d{4})-W(\d{2})\.json$"
)
_RE_MF_TRADERS_MANUAL = re.compile(
    r"^backups/map-features-traders-(\d{4})-W(\d{2})-manual-(\d+)\.json$"
)


def _classify_mf_traders(key: str) -> Optional[str]:
    if _RE_MF_TRADERS_SCHEDULED.match(key):
        return "scheduled"
    if _RE_MF_TRADERS_MANUAL.match(key):
        return "manual"
    return None


def list_map_features_traders_backups() -> List[dict]:
    """Return all map-features traders backup objects, newest first."""
    out = []
    for obj in r2_storage.list_backup_objects():
        kind = _classify_mf_traders(obj["key"])
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


def _snapshot_map_features_traders_to(target_key: str) -> str:
    """Cross-bucket copy of the live merged traders list into ``target_key``."""
    src_bucket, src_key = r2_storage.map_features_traders_live()
    r2_storage.copy_object_from_bucket(src_bucket, src_key, target_key)
    return target_key


def create_scheduled_map_features_traders_snapshot_if_due() -> Optional[str]:
    """Create this period's scheduled snapshot of ``map-features.traders.json``.

    Cadence follows the admin-configured ``map_features_traders`` schedule
    (weekly / biweekly / monthly / disabled). Idempotent — skips when the
    current ISO week already has a snapshot. Skips silently when the live file
    is missing (e.g. no contributions published yet). Returns the new key or
    None.
    """
    iso_year, iso_week = _now_iso_week()
    existing = list_map_features_traders_backups()
    scheduled = [b for b in existing if b["kind"] == "scheduled"]
    newest = _parse_iso(scheduled[0]["last_modified"]) if scheduled else None
    if not _interval_due("map_features_traders", newest):
        return None
    target = r2_storage.map_features_traders_backup_scheduled_key(iso_year, iso_week)
    if r2_storage.object_exists(target):
        return None
    src_bucket, src_key = r2_storage.map_features_traders_live()
    if not r2_storage.object_exists_in_bucket(src_bucket, src_key):
        logger.info(
            "weekly_backup: map-features traders live file missing — skipping snapshot"
        )
        return None
    try:
        _snapshot_map_features_traders_to(target)
    except Exception:
        logger.exception("weekly_backup: failed to snapshot map-features traders")
        return None
    logger.info("weekly_backup: created scheduled map-features traders snapshot %s", target)
    return target


def create_manual_map_features_traders_snapshot() -> str:
    """Force-create a manual snapshot of ``map-features.traders.json`` now."""
    src_bucket, src_key = r2_storage.map_features_traders_live()
    if not r2_storage.object_exists_in_bucket(src_bucket, src_key):
        raise FileNotFoundError("map-features traders live file is not present in R2")
    iso_year, iso_week = _now_iso_week()
    ts = int(datetime.now(timezone.utc).timestamp())
    target = r2_storage.map_features_traders_backup_manual_key(iso_year, iso_week, ts)
    _snapshot_map_features_traders_to(target)
    logger.info("weekly_backup: created manual map-features traders snapshot %s", target)
    return target


def cleanup_old_map_features_traders_backups() -> dict:
    """Trim scheduled + manual map-features traders backups to retention."""
    backups = list_map_features_traders_backups()
    scheduled = [b for b in backups if b["kind"] == "scheduled"]
    manual = [b for b in backups if b["kind"] == "manual"]
    to_delete: List[str] = []
    if settings.BACKUP_KEEP_SCHEDULED >= 0:
        to_delete.extend(b["key"] for b in scheduled[settings.BACKUP_KEEP_SCHEDULED:])
    if settings.BACKUP_KEEP_MANUAL >= 0:
        to_delete.extend(b["key"] for b in manual[settings.BACKUP_KEEP_MANUAL:])
    if to_delete:
        r2_storage.delete_keys(to_delete)
        logger.info(
            "weekly_backup: deleted %d old map-features traders snapshots", len(to_delete)
        )
    return {"deleted": len(to_delete)}


def _snapshot_map_features_traders_restore(backup_key: str) -> dict:
    """Copy a map-features-traders backup object back over the live file.

    The backup lives in the default backup bucket; the live file lives in the
    public map-features bucket. Returns a small report dict. Raises
    ``FileNotFoundError`` when the backup key is missing and ``ValueError``
    when it isn't a recognised snapshot.
    """
    if _classify_mf_traders(backup_key) is None:
        raise ValueError(f"backup key {backup_key!r} is not a map-features traders backup")
    if not r2_storage.object_exists(backup_key):
        raise FileNotFoundError(f"backup not found: {backup_key}")
    live_bucket, live_key = r2_storage.map_features_traders_live()
    r2_storage.copy_object_to_bucket(backup_key, live_bucket, live_key)
    r2_storage.invalidate_presigned_download_url(live_key)
    logger.info("weekly_backup: restored map-features traders from %s", backup_key)
    return {"restored": "map_features_traders", "from_key": backup_key, "live_key": live_key}


def restore_map_features_traders_from_backup(backup_key: str) -> dict:
    """Public wrapper around :func:`_snapshot_map_features_traders_restore`."""
    return _snapshot_map_features_traders_restore(backup_key)


# ---------------------------------------------------------------------------
# Elk-walkable — scheduled on-demand snapshots
# ---------------------------------------------------------------------------
#
# Unlike the geojson / map-features assets, elk-walkable already writes a
# rolling pre-mutation snapshot on every edit. The scheduled job here just
# guarantees a periodic restore point exists even during quiet periods,
# honouring the admin-configured ``elk_walkable`` cadence.

def create_scheduled_elk_walkable_snapshot_if_due() -> Optional[str]:
    """Force an elk-walkable snapshot when the configured interval has elapsed
    since the newest existing snapshot. Returns the new key or None."""
    from ..core import elk_walkable_store as elk

    newest = elk.newest_snapshot_mtime()
    if not _interval_due("elk_walkable", newest):
        return None
    if not r2_storage.object_exists(r2_storage.elk_walkable_live_key()):
        logger.info("weekly_backup: elk-walkable live file missing — skipping snapshot")
        return None
    try:
        result = elk.create_manual_snapshot(
            actor_api_key_id=None, actor_display_name="scheduler"
        )
    except Exception:
        logger.exception("weekly_backup: failed to snapshot elk-walkable")
        return None
    key = result.get("snapshot_key")
    logger.info("weekly_backup: created scheduled elk-walkable snapshot %s", key)
    return key


# ---------------------------------------------------------------------------
# Merged public map-features rapids list — scheduled snapshots
# ---------------------------------------------------------------------------
#
# Mirrors the map-features traders flow: the crowd-sourced
# ``map-features.rapids.json`` (rebuilt from every /contribute-map-features
# upload and published to the PUBLIC map-features bucket) is snapshotted into
# ``backups/`` on the admin-configured ``map_features_rapids`` cadence.
#
# Storage layout (under ``backups/``):
#   map-features-rapids-YYYY-Www.json
#   map-features-rapids-YYYY-Www-manual-<unix>.json

_RE_MF_RAPIDS_SCHEDULED = re.compile(
    r"^backups/map-features-rapids-(\d{4})-W(\d{2})\.json$"
)
_RE_MF_RAPIDS_MANUAL = re.compile(
    r"^backups/map-features-rapids-(\d{4})-W(\d{2})-manual-(\d+)\.json$"
)


def _classify_mf_rapids(key: str) -> Optional[str]:
    if _RE_MF_RAPIDS_SCHEDULED.match(key):
        return "scheduled"
    if _RE_MF_RAPIDS_MANUAL.match(key):
        return "manual"
    return None


def list_map_features_rapids_backups() -> List[dict]:
    """Return all map-features rapids backup objects, newest first."""
    out = []
    for obj in r2_storage.list_backup_objects():
        kind = _classify_mf_rapids(obj["key"])
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


def _snapshot_map_features_rapids_to(target_key: str) -> str:
    """Cross-bucket copy of the live merged rapids list into ``target_key``."""
    src_bucket, src_key = r2_storage.map_features_rapids_live()
    r2_storage.copy_object_from_bucket(src_bucket, src_key, target_key)
    return target_key


def create_scheduled_map_features_rapids_snapshot_if_due() -> Optional[str]:
    """Create this period's scheduled snapshot of ``map-features.rapids.json``.

    Cadence follows the admin-configured ``map_features_rapids`` schedule
    (weekly / biweekly / monthly / disabled). Idempotent — skips when the
    current ISO week already has a snapshot. Skips silently when the live file
    is missing. Returns the new key or None.
    """
    iso_year, iso_week = _now_iso_week()
    existing = list_map_features_rapids_backups()
    scheduled = [b for b in existing if b["kind"] == "scheduled"]
    newest = _parse_iso(scheduled[0]["last_modified"]) if scheduled else None
    if not _interval_due("map_features_rapids", newest):
        return None
    target = r2_storage.map_features_rapids_backup_scheduled_key(iso_year, iso_week)
    if r2_storage.object_exists(target):
        return None
    src_bucket, src_key = r2_storage.map_features_rapids_live()
    if not r2_storage.object_exists_in_bucket(src_bucket, src_key):
        logger.info(
            "weekly_backup: map-features rapids live file missing — skipping snapshot"
        )
        return None
    try:
        _snapshot_map_features_rapids_to(target)
    except Exception:
        logger.exception("weekly_backup: failed to snapshot map-features rapids")
        return None
    logger.info("weekly_backup: created scheduled map-features rapids snapshot %s", target)
    return target


def create_manual_map_features_rapids_snapshot() -> str:
    """Force-create a manual snapshot of ``map-features.rapids.json`` now."""
    src_bucket, src_key = r2_storage.map_features_rapids_live()
    if not r2_storage.object_exists_in_bucket(src_bucket, src_key):
        raise FileNotFoundError("map-features rapids live file is not present in R2")
    iso_year, iso_week = _now_iso_week()
    ts = int(datetime.now(timezone.utc).timestamp())
    target = r2_storage.map_features_rapids_backup_manual_key(iso_year, iso_week, ts)
    _snapshot_map_features_rapids_to(target)
    logger.info("weekly_backup: created manual map-features rapids snapshot %s", target)
    return target


def cleanup_old_map_features_rapids_backups() -> dict:
    """Trim scheduled + manual map-features rapids backups to retention."""
    backups = list_map_features_rapids_backups()
    scheduled = [b for b in backups if b["kind"] == "scheduled"]
    manual = [b for b in backups if b["kind"] == "manual"]
    to_delete: List[str] = []
    if settings.BACKUP_KEEP_SCHEDULED >= 0:
        to_delete.extend(b["key"] for b in scheduled[settings.BACKUP_KEEP_SCHEDULED:])
    if settings.BACKUP_KEEP_MANUAL >= 0:
        to_delete.extend(b["key"] for b in manual[settings.BACKUP_KEEP_MANUAL:])
    if to_delete:
        r2_storage.delete_keys(to_delete)
        logger.info(
            "weekly_backup: deleted %d old map-features rapids snapshots", len(to_delete)
        )
    return {"deleted": len(to_delete)}


def _snapshot_map_features_rapids_restore(backup_key: str) -> dict:
    """Copy a map-features-rapids backup object back over the live file."""
    if _classify_mf_rapids(backup_key) is None:
        raise ValueError(f"backup key {backup_key!r} is not a map-features rapids backup")
    if not r2_storage.object_exists(backup_key):
        raise FileNotFoundError(f"backup not found: {backup_key}")
    live_bucket, live_key = r2_storage.map_features_rapids_live()
    r2_storage.copy_object_to_bucket(backup_key, live_bucket, live_key)
    r2_storage.invalidate_presigned_download_url(live_key)
    logger.info("weekly_backup: restored map-features rapids from %s", backup_key)
    return {"restored": "map_features_rapids", "from_key": backup_key, "live_key": live_key}


def restore_map_features_rapids_from_backup(backup_key: str) -> dict:
    """Public wrapper around :func:`_snapshot_map_features_rapids_restore`."""
    return _snapshot_map_features_rapids_restore(backup_key)


# ---------------------------------------------------------------------------
# Upstream TOPS translocators geojson — scheduled snapshots
# ---------------------------------------------------------------------------
#
# Unlike every other backed-up asset there is no "live" copy in our buckets:
# the translocators data is proxied live from the upstream map host and never
# stored. To keep a copy in case the upstream goes down, we fetch it fresh
# from ``settings.TOPS_TRANSLOCATORS_BACKUP_URL`` and store the raw bytes
# directly under ``backups/``. There is intentionally no restore path.
#
# Storage layout (under ``backups/``):
#   tops-translocators-YYYY-Www.json
#   tops-translocators-YYYY-Www-manual-<unix>.json

_RE_TOPS_TL_SCHEDULED = re.compile(
    r"^backups/tops-translocators-(\d{4})-W(\d{2})\.json$"
)
_RE_TOPS_TL_MANUAL = re.compile(
    r"^backups/tops-translocators-(\d{4})-W(\d{2})-manual-(\d+)\.json$"
)

# Cap on the upstream response we'll buffer into memory (same as the proxy).
_TOPS_TL_MAX_BYTES = 32 * 1024 * 1024
_TOPS_TL_REQUEST_TIMEOUT_S = 20.0
_TOPS_TL_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 CairnMapProxy/1.0"
)


def _classify_tops_tl(key: str) -> Optional[str]:
    if _RE_TOPS_TL_SCHEDULED.match(key):
        return "scheduled"
    if _RE_TOPS_TL_MANUAL.match(key):
        return "manual"
    return None


def list_tops_translocators_backups() -> List[dict]:
    """Return all upstream-translocators backup objects, newest first."""
    out = []
    for obj in r2_storage.list_backup_objects():
        kind = _classify_tops_tl(obj["key"])
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


def _fetch_tops_translocators_bytes() -> bytes:
    """Fetch the upstream translocators geojson. Raises on any failure so the
    caller can surface it (manual) or log + skip (scheduled)."""
    import urllib.error
    import urllib.request

    url = settings.TOPS_TRANSLOCATORS_BACKUP_URL
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/geo+json, application/json",
            "Accept-Language": "en-US,en;q=0.9",
            "User-Agent": _TOPS_TL_USER_AGENT,
        },
    )
    with urllib.request.urlopen(  # noqa: S310 - fixed https URL from settings
        req, timeout=_TOPS_TL_REQUEST_TIMEOUT_S
    ) as resp:
        raw = resp.read(_TOPS_TL_MAX_BYTES + 1)
    if len(raw) > _TOPS_TL_MAX_BYTES:
        raise ValueError("upstream translocators geojson too large")
    # Validate it's JSON so we never store a Cloudflare error page as a backup.
    import json as _json
    try:
        _json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, _json.JSONDecodeError) as exc:
        raise ValueError("upstream returned invalid JSON") from exc
    return raw


def _snapshot_tops_translocators_to(target_key: str) -> str:
    """Fetch the upstream translocators geojson and store it at ``target_key``."""
    raw = _fetch_tops_translocators_bytes()
    r2_storage.upload_bytes(target_key, raw, content_type="application/geo+json")
    return target_key


def create_scheduled_tops_translocators_snapshot_if_due() -> Optional[str]:
    """Create this period's scheduled upstream-translocators snapshot.

    Cadence follows the admin-configured ``tops_translocators`` schedule
    (weekly / biweekly / monthly / disabled). Idempotent — skips when the
    current ISO week already has a snapshot. Fetch failures are logged and
    swallowed (the upstream may simply be down). Returns the new key or None.
    """
    iso_year, iso_week = _now_iso_week()
    existing = list_tops_translocators_backups()
    scheduled = [b for b in existing if b["kind"] == "scheduled"]
    newest = _parse_iso(scheduled[0]["last_modified"]) if scheduled else None
    if not _interval_due("tops_translocators", newest):
        return None
    target = r2_storage.tops_translocators_backup_scheduled_key(iso_year, iso_week)
    if r2_storage.object_exists(target):
        return None
    try:
        _snapshot_tops_translocators_to(target)
    except Exception:
        logger.exception(
            "weekly_backup: failed to snapshot upstream translocators (upstream down?)"
        )
        return None
    logger.info("weekly_backup: created scheduled upstream-translocators snapshot %s", target)
    return target


def create_manual_tops_translocators_snapshot() -> str:
    """Force-create a manual snapshot of the upstream translocators now.

    Raises on fetch/validation failure so the admin sees why it didn't work.
    """
    iso_year, iso_week = _now_iso_week()
    ts = int(datetime.now(timezone.utc).timestamp())
    target = r2_storage.tops_translocators_backup_manual_key(iso_year, iso_week, ts)
    _snapshot_tops_translocators_to(target)
    logger.info("weekly_backup: created manual upstream-translocators snapshot %s", target)
    return target


def cleanup_old_tops_translocators_backups() -> dict:
    """Trim scheduled + manual upstream-translocators backups to retention."""
    backups = list_tops_translocators_backups()
    scheduled = [b for b in backups if b["kind"] == "scheduled"]
    manual = [b for b in backups if b["kind"] == "manual"]
    to_delete: List[str] = []
    if settings.BACKUP_KEEP_SCHEDULED >= 0:
        to_delete.extend(b["key"] for b in scheduled[settings.BACKUP_KEEP_SCHEDULED:])
    if settings.BACKUP_KEEP_MANUAL >= 0:
        to_delete.extend(b["key"] for b in manual[settings.BACKUP_KEEP_MANUAL:])
    if to_delete:
        r2_storage.delete_keys(to_delete)
        logger.info(
            "weekly_backup: deleted %d old upstream-translocators snapshots", len(to_delete)
        )
    return {"deleted": len(to_delete)}

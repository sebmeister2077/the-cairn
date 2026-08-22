"""Debounced, single-flight rebuild of the public map-features files.

Triggered after each map-features contribution ingest (and by the admin
rebuild / source revoke endpoints). Coalesces a burst of contributions into one
rebuild: it waits for a quiet window after the last request, capped by a hard
max interval so a steady stream still refreshes periodically.

A rebuild reads every NON-revoked raw object from the private bucket (plus the
seed), union-merges them per category, and publishes the merged per-category
files (``map-features.<cat>.json``), a combined backup document
(``map-features.json``) and a ``manifest.json`` pointer to the PUBLIC bucket.
The raw documents never leave the private bucket.
"""

from __future__ import annotations

import asyncio
import ctypes
import ctypes.util
import gc
import hashlib
import json
import logging
import os
import sys
import tempfile
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple

from ..config import settings
from . import map_features_merge, map_features_raw_store, database

logger = logging.getLogger("uvicorn.error")

# glibc malloc_trim(0): return freed heap to the OS. Python frees the big
# transient JSON buffers after each rebuild/ingest, but glibc keeps them in its
# arenas so RSS only ratchets up. None=untried, False=unavailable, else callable.
_libc_malloc_trim: Any = None


def _malloc_trim() -> None:
    global _libc_malloc_trim
    if _libc_malloc_trim is None:
        try:
            libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6")
            _libc_malloc_trim = getattr(libc, "malloc_trim", False)
        except Exception:
            _libc_malloc_trim = False
    if _libc_malloc_trim:
        try:
            _libc_malloc_trim(0)
        except Exception:
            pass


# Opt-in leak hunt: set MAP_FEATURES_TRACEMALLOC=1 to log which object TYPES grew
# between rebuilds. Uses a gc census (runs once per rebuild, ~1/min) instead of
# tracemalloc — no per-allocation overhead, so it can't slow ingests.
_TRACE = os.environ.get("MAP_FEATURES_TRACEMALLOC", "").strip().lower() in ("1", "true", "yes")
_prev_type_counts: "Counter | None" = None


def _log_gc_type_delta() -> None:
    """Log the object types whose live count grew most since the last rebuild."""
    global _prev_type_counts
    if not _TRACE:
        return
    counts: "Counter" = Counter(type(o).__name__ for o in gc.get_objects())
    if _prev_type_counts is not None:
        deltas = sorted(
            ((counts[k] - _prev_type_counts.get(k, 0), k) for k in counts),
            reverse=True,
        )
        for delta, name in deltas[:10]:
            if delta > 0:
                logger.info(
                    "[map-features-mem] +%d %s (live=%d)", delta, name, counts[name]
                )
    _prev_type_counts = counts




def _rss_mb() -> float:
    """Resident set size in MB (Linux); 0.0 where /proc is unavailable."""
    try:
        with open("/proc/self/status", "r") as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024.0
    except OSError:
        pass
    return 0.0


def _cgroup_mem_mb() -> Tuple[float, float]:
    """(current, limit) container memory in MB from the cgroup; (0,0) if absent.

    Unlike RSS this includes page cache + tmpfs — i.e. what the OOM killer
    actually accounts against the container limit, which the Railway dashboard's
    sampled process metric can under-report."""

    def _read(paths: List[str]) -> int:
        for p in paths:
            try:
                with open(p, "r") as fh:
                    v = fh.read().strip()
                if v and v != "max":
                    return int(v)
            except (OSError, ValueError):
                continue
        return 0

    cur = _read(
        ["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"]
    )
    lim = _read(
        ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]
    )
    mb = 1 << 20
    return cur / mb, lim / mb



# backend/ dir holds the standalone process_auction_data.py / auction_r2_publish.py
_BACKEND_DIR = Path(__file__).resolve().parents[2]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

# Key that a contributor api_key must carry to count as an active source.
_PUBLISH_PERMISSION = "map_features_publish"

_request_event: asyncio.Event | None = None
_worker_task: asyncio.Task | None = None
# Created lazily inside the running loop (avoids binding to the wrong loop on 3.9).
_build_lock: asyncio.Lock | None = None


# --------------------------------------------------------------------------- #
# Source gathering + merge (sync — runs in a thread executor)
# --------------------------------------------------------------------------- #
def _has_publish_permission(row: Dict[str, Any]) -> bool:
    extras = row.get("extra_permissions")
    if isinstance(extras, str):
        try:
            extras = json.loads(extras)
        except ValueError:
            extras = None
    return bool(isinstance(extras, dict) and extras.get(_PUBLISH_PERMISSION))


def _active_source_ids(exclude_ids: Set[str]) -> List[str]:
    """Raw object ids to include: the seed + every non-revoked contributor that
    still holds the map-features publish permission."""
    out: List[str] = []
    for sid in map_features_raw_store.list_raw_ids():
        if sid in exclude_ids:
            continue
        if sid == map_features_raw_store.SEED_ID:
            out.append(sid)
            continue
        row = database.get_api_key_by_id(sid)
        if not row or row.get("revoked") or not _has_publish_permission(row):
            continue
        out.append(sid)
    return out


def _merge(exclude_ids: Set[str] | None = None) -> Dict[str, Any]:
    exclude_ids = exclude_ids or set()
    sids = _active_source_ids(exclude_ids)
    sources: List[Tuple[str, Dict[str, Any]]] = []
    for sid in sids:
        doc = map_features_raw_store.get_document(sid)
        if doc is not None:
            sources.append((sid, doc))
    merged = map_features_merge.merge_documents(sources)
    logger.info(
        "[map-features-rebuild] merged %d sources -> %s",
        len(sources),
        ", ".join(f"{c}={len(merged.get(k, []))}" for k, c in map_features_merge.CATEGORIES),
    )
    return merged


# Content hash of the last dataset published to R2, so an unchanged dataset is
# never rewritten. ``None`` until the first publish or a baseline read from R2.
_last_published_hash: "str | None" = None
_baseline_seeded = False


def _stable_data_hash(merged: Dict[str, Any]) -> str:
    """Short content hash over the merged feature payload only — deliberately
    excludes ``generatedUtc`` so an identical dataset hashes identically across
    rebuilds. Keyed by category in a fixed order for determinism."""
    payload: Dict[str, Any] = {
        "upstream": merged.get("upstream"),
        "worldSpawn": merged.get("worldSpawn"),
    }
    for doc_key, _cat in map_features_merge.CATEGORIES:
        payload[doc_key] = merged.get(doc_key, [])
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]


def _published_version_on_r2(auction_r2_publish) -> "str | None":
    """The ``version`` of the currently-published manifest, or None if absent."""
    data = auction_r2_publish.read_bytes_from_bucket(
        bucket=settings.MAP_FEATURES_PUBLIC_BUCKET,
        key=f"{settings.MAP_FEATURES_PREFIX}/manifest.json",
    )
    if not data:
        return None
    try:
        return json.loads(data).get("version")
    except (json.JSONDecodeError, ValueError):
        return None


def _feature_file(cat: str, merged: Dict[str, Any], doc_key: str, now_iso: str) -> Dict[str, Any]:
    """One self-describing per-category envelope (matches the proxy split writer
    and what the frontend loads)."""
    feats = merged.get(doc_key, [])
    env: Dict[str, Any] = {
        "generatedUtc": now_iso,
        "category": cat,
        "count": len(feats),
        "features": feats,
    }
    if merged.get("upstream"):
        env["upstream"] = merged["upstream"]
    if merged.get("worldSpawn") is not None:
        env["worldSpawn"] = merged["worldSpawn"]
    return env


def _build_and_publish() -> Dict[str, int]:
    global _last_published_hash, _baseline_seeded
    import auction_r2_publish  # noqa: WPS433 — backend/ module (shared R2 uploader)
    import process_auction_data as pad  # noqa: WPS433 — backend/ module (write_json/manifest)

    merged = _merge()
    data_hash = _stable_data_hash(merged)
    counts = {c: len(merged.get(k, [])) for k, c in map_features_merge.CATEGORIES}

    # Seed the baseline from whatever is already published (once per process) so
    # a restart never republishes an unchanged dataset.
    if not _baseline_seeded:
        _last_published_hash = _published_version_on_r2(auction_r2_publish)
        _baseline_seeded = True

    # Change-detection: skip the R2 write entirely when the merged features are
    # byte-for-byte the same as what's already published (the proxy re-uploads
    # its full export ~1/min, so most rebuilds carry no new data).
    if data_hash == _last_published_hash:
        logger.info(
            "[map-features-rebuild] data unchanged (v=%s) — skipping R2 publish.", data_hash
        )
        return counts

    now_iso = datetime.now(timezone.utc).isoformat()

    with tempfile.TemporaryDirectory(prefix="map-features-rebuild-") as tmp:
        out = Path(tmp)
        files: List[Path] = []
        for doc_key, cat in map_features_merge.CATEGORIES:
            path = out / f"map-features.{cat}.json"
            pad.write_json(path, _feature_file(cat, merged, doc_key, now_iso))
            files.append(path)

        # Combined backup document (all categories) — the "main" file.
        combined = {"generatedUtc": now_iso, **merged}
        combined_path = out / "map-features.json"
        pad.write_json(combined_path, combined)
        files.append(combined_path)

        # Manifest version is the stable data hash (not a hash of the timestamped
        # files) so the frontend's ``?v=`` only flips when features actually
        # change — keeping the CDN cache warm between real updates.
        manifest_path = out / "manifest.json"
        pad.write_json(
            manifest_path,
            {
                "version": data_hash,
                "generatedUtc": now_iso,
                "files": sorted(p.name for p in files),
            },
        )
        auction_r2_publish.publish_files_to_bucket(
            files + [manifest_path],
            bucket=settings.MAP_FEATURES_PUBLIC_BUCKET,
            prefix=settings.MAP_FEATURES_PREFIX,
            log=lambda m: logger.info("%s", m),
        )
    _last_published_hash = data_hash
    return counts


def source_impact(key_id: str) -> Dict[str, int]:
    """Dry-run: how a rebuild WITHOUT ``key_id`` would differ from WITH it.
    Returns per-category feature counts with and without the source."""
    with_src = _merge()
    without_src = _merge({key_id})
    result: Dict[str, int] = {}
    for doc_key, cat in map_features_merge.CATEGORIES:
        result[f"{cat}_with"] = len(with_src.get(doc_key, []))
        result[f"{cat}_without"] = len(without_src.get(doc_key, []))
    return result


# --------------------------------------------------------------------------- #
# Async coalescer
# --------------------------------------------------------------------------- #
async def rebuild_now() -> Dict[str, int]:
    """Run a rebuild immediately (single-flight). Awaitable; used by admin ops."""
    global _build_lock
    if _build_lock is None:
        _build_lock = asyncio.Lock()
    async with _build_lock:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _build_and_publish)


async def _worker() -> None:
    assert _request_event is not None
    while True:
        await _request_event.wait()
        first_requested = time.monotonic()
        debounce = max(1, settings.MAP_FEATURES_REBUILD_DEBOUNCE_SECONDS)
        max_interval = max(debounce, settings.MAP_FEATURES_REBUILD_MAX_INTERVAL_SECONDS)
        # Absorb a burst: reset the quiet window on each new request, but never
        # wait longer than max_interval since the first request in this batch.
        while True:
            _request_event.clear()
            try:
                await asyncio.wait_for(_request_event.wait(), timeout=debounce)
            except asyncio.TimeoutError:
                break
            if time.monotonic() - first_requested >= max_interval:
                break
        try:
            rss_before = _rss_mb()
            result = await rebuild_now()
            # Release the merge/encode graph AND hand the freed heap back to the
            # OS — glibc otherwise keeps it in-arena and RSS only grows.
            gc.collect()
            _malloc_trim()
            cur, lim = _cgroup_mem_mb()
            logger.info(
                "[map-features-rebuild] published %s rss=%.0fMB (was %.0fMB) cgroup=%.0f/%.0fMB",
                result,
                _rss_mb(),
                rss_before,
                cur,
                lim,
            )
            _log_gc_type_delta()
        except Exception as exc:  # noqa: BLE001 — never crash the worker loop
            logger.warning(
                "[map-features-rebuild] failed (will retry on next request): %s", exc
            )


def request_rebuild() -> None:
    """Signal the coalescer that a rebuild is due (non-blocking, best-effort)."""
    if _request_event is not None:
        _request_event.set()


def start() -> None:
    """Start the background coalescer. Call once from the app lifespan."""
    global _request_event, _worker_task
    if _worker_task is not None:
        return
    _request_event = asyncio.Event()
    _worker_task = asyncio.create_task(_worker())


async def stop() -> None:
    global _worker_task
    if _worker_task is not None:
        _worker_task.cancel()
        try:
            await _worker_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        _worker_task = None

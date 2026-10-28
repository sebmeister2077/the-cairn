"""Debounced, single-flight rebuild of the public map-features files.

Triggered after each map-features contribution ingest (and by the admin
rebuild / source revoke endpoints). Coalesces a burst of contributions into one
rebuild: it waits for a quiet window after the last request, capped by a hard
max interval so a steady stream still refreshes periodically.

A rebuild reads every NON-revoked raw object from the private bucket (plus the
seed), union-merges them per category, and publishes the merged per-category
files (``map-features.<cat>.json``) and a ``manifest.json`` pointer to the
PUBLIC bucket. The raw documents never leave the private bucket.

Two cost controls keep this cheap enough for a small (sub-1 GB) container even
though the proxy re-uploads its full export ~1/min:

* **ETag short-circuit** — before doing any download/parse/merge, the coalescer
  fingerprints the active sources by their R2 ETags. If nothing changed since
  the last publish it skips the whole rebuild.
* **Streaming merge in a subprocess** — when a rebuild is actually needed the
  merge/publish runs in a short-lived child process that folds one source
  document at a time, so peak RAM is one source + the accumulator, and the OS
  reclaims all of it when the child exits (glibc keeps freed arenas otherwise).
"""

from __future__ import annotations

import asyncio
import ctypes
import ctypes.util
import functools
import gc
import hashlib
import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter, OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from ..config import settings
from . import map_features_merge, map_features_raw_store, database
from .rebuild_memory import REBUILD_MEMORY_LOCK

logger = logging.getLogger("uvicorn.error")

# Set in the short-lived rebuild subprocess so it never tries to spawn its own
# child (it calls the heavy worker directly). Result line prefix the parent
# scans for on the child's stdout.
_CHILD = os.environ.get("MAP_FEATURES_REBUILD_RUN_CHILD") == "1"
_RESULT_PREFIX = "__MFRESULT__ "

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

# Per-category lists that get their own audit row when they change at publish
# time. Deliberately excludes the high-churn claim categories (per-observation
# player-claim replacement would spam the feed) — add 'traderclaims' /
# 'playerclaims' here if a moderation view for them is ever built.
AUDITED_CATEGORIES: Tuple[str, ...] = ("translocators", "traders", "rapids")

# Contributors (api_key_id -> display name, newest last) that have uploaded
# since the last *published* change. Consumed + cleared only when a real change
# publishes, so a change is attributed to whoever fed data into the window that
# produced it. Guarded by a lock: ingest runs on the event loop while the
# rebuild drains this from an executor thread.
_contrib_lock = threading.Lock()
_contributors_since_publish: "OrderedDict[str, Optional[str]]" = OrderedDict()


def note_contributor(key_id: str, display_name: Optional[str]) -> None:
    """Record an accepted contribution so the next published change can be
    attributed to it. Cheap + thread-safe; replaces the old per-upload audit
    row (the proxy re-uploads ~1/min, so most uploads change nothing)."""
    if not key_id:
        return
    with _contrib_lock:
        _contributors_since_publish.pop(key_id, None)
        _contributors_since_publish[key_id] = display_name


def _take_contributors() -> "List[Tuple[str, Optional[str]]]":
    """Snapshot and clear the pending contributors (oldest first)."""
    with _contrib_lock:
        items = list(_contributors_since_publish.items())
        _contributors_since_publish.clear()
    return items


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


def _active_sources(exclude_ids: Set[str] | None = None) -> List[Dict[str, Any]]:
    """Per-contributor source descriptors a rebuild includes: the seed + every
    non-revoked contributor that still holds the map-features publish permission.

    Each descriptor is ``{id, base_etag, last_modified, deltas}`` where ``deltas``
    is ``[{seq, etag, last_modified}, ...]`` in apply order — so a contributor's
    base snapshot and its append-only delta stream travel together."""
    exclude_ids = exclude_ids or set()
    out: List[Dict[str, Any]] = []
    for sid, slot in map_features_raw_store.list_grouped_objects().items():
        if sid in exclude_ids:
            continue
        base = slot.get("base")
        deltas = slot.get("deltas") or []
        if base is None and not deltas:
            continue
        if sid != map_features_raw_store.SEED_ID:
            row = database.get_api_key_by_id(sid)
            if not row or row.get("revoked") or not _has_publish_permission(row):
                continue
            # Only apply deltas up to the COMMITTED version — objects beyond it are
            # orphans from a lost optimistic-update race and must be ignored.
            if deltas:
                state = database.get_map_features_contrib_state(sid) or {}
                version = int(state.get("version") or 0)
                deltas = [d for d in deltas if d["seq"] <= version]
        out.append(
            {
                "id": sid,
                "base_etag": (base or {}).get("etag"),
                "last_modified": _slot_last_modified(base, deltas),
                "deltas": deltas,
            }
        )
    return out


def _slot_last_modified(base: Optional[Dict[str, Any]], deltas: List[Dict[str, Any]]) -> Any:
    """Newest R2 ``LastModified`` across a contributor's base + deltas — the
    contributor's effective upload time for the last-writer-wins ordering."""
    times = []
    if base and base.get("last_modified") is not None:
        times.append(base["last_modified"])
    for d in deltas:
        if d.get("last_modified") is not None:
            times.append(d["last_modified"])
    return max(times) if times else None


def _fingerprint(active: List[Dict[str, Any]]) -> Tuple[Tuple[str, str], ...]:
    """A cheap identity of the active dataset: sorted ``(id, etag-chain)`` pairs
    where the chain covers the base ETag AND every delta ETag. Two fingerprints
    are equal iff the same sources with the same base+deltas are present — so an
    unchanged fingerprint means the merge reproduces identical output."""
    out: List[Tuple[str, str]] = []
    for src in active:
        chain = (src.get("base_etag") or "") + "|" + ",".join(
            f"{d['seq']}:{d.get('etag') or ''}" for d in src.get("deltas", [])
        )
        out.append((src["id"], chain))
    return tuple(sorted(out))


def _order_key(src: Dict[str, Any]) -> Tuple[float, str]:
    """Sort key for the last-writer-wins fold: oldest upload first. R2's
    LastModified approximates each contributor's ``generatedUtc``; a missing time
    sorts first (treated as oldest)."""
    lm = src.get("last_modified")
    ts = lm.timestamp() if hasattr(lm, "timestamp") else 0.0
    return (ts, src["id"])


def _reconstruct_source(src: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Fetch a contributor's base snapshot + delta objects and reconstruct its
    current ``MapExportDocument``. Base-only sources (seed / legacy full
    contributors) skip reconstruction and return the base directly."""
    sid = src["id"]
    deltas = src.get("deltas") or []
    base = map_features_raw_store.get_document(sid) if src.get("base_etag") else None
    if not deltas:
        return base
    delta_docs = []
    for d in deltas:
        doc = map_features_raw_store.get_delta_document(sid, d["seq"])
        if doc is not None:
            delta_docs.append(doc)
    return map_features_merge.reconstruct_document(base, delta_docs)


def _merge_streaming(active: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Fold every active source into the merge ONE AT A TIME, reconstructing each
    contributor from its base + deltas first, so peak memory is a single
    contributor snapshot plus the winners accumulator."""
    acc = map_features_merge.new_accumulator()
    n = 0
    for src in sorted(active, key=_order_key):
        doc = _reconstruct_source(src)
        if doc is None:
            continue
        map_features_merge.fold_document(acc, doc)
        del doc  # release this source before fetching the next
        n += 1
    merged = map_features_merge.finalize(acc)
    del acc
    logger.info(
        "[map-features-rebuild] merged %d sources -> %s",
        n,
        ", ".join(f"{c}={len(merged.get(k, []))}" for k, c in map_features_merge.CATEGORIES),
    )
    return merged


def _merge(exclude_ids: Set[str] | None = None) -> Dict[str, Any]:
    return _merge_streaming(_active_sources(exclude_ids))


# Content hash of the last dataset published to R2, so an unchanged dataset is
# never rewritten. ``None`` until the first publish or a baseline read from R2.
_last_published_hash: "str | None" = None
_baseline_seeded = False
# Fingerprint (sorted id/etag pairs) of the sources behind the last rebuild, so
# a rebuild whose sources are byte-identical can skip the merge entirely.
_last_source_fingerprint: "Tuple[Tuple[str, str], ...] | None" = None
# Per-category content hashes behind the last publish, so each category's audit
# row is written only when THAT category actually changed. ``None`` until seeded
# from the manifest or the first publish.
_last_category_hashes: "Dict[str, str] | None" = None


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


def _stable_category_hashes(merged: Dict[str, Any]) -> Dict[str, str]:
    """Per-category content hash (``cat`` -> short hash), so a publish can tell
    exactly which lists changed. Each hash covers only that category's features
    (not ``generatedUtc``), so an unchanged list hashes identically."""
    out: Dict[str, str] = {}
    for doc_key, cat in map_features_merge.CATEGORIES:
        blob = json.dumps(
            merged.get(doc_key, []),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        out[cat] = hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]
    return out


def _published_state_on_r2(auction_r2_publish) -> "Tuple[str | None, Dict[str, str]]":
    """``(version, categoryVersions)`` from the currently-published manifest, so
    a fresh process reseeds its baselines without republishing. Missing/legacy
    manifests yield ``(None, {})``."""
    data = auction_r2_publish.read_bytes_from_bucket(
        bucket=settings.MAP_FEATURES_PUBLIC_BUCKET,
        key=f"{settings.MAP_FEATURES_PREFIX}/manifest.json",
    )
    if not data:
        return None, {}
    try:
        manifest = json.loads(data)
    except (json.JSONDecodeError, ValueError):
        return None, {}
    cats = manifest.get("categoryVersions")
    return manifest.get("version"), dict(cats) if isinstance(cats, dict) else {}


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


def _do_merge_and_publish(
    prev_hash: "str | None",
) -> "Tuple[Dict[str, int], str, Dict[str, str], bool]":
    """Merge every active source and publish the per-category files + manifest.

    Skips the R2 write when the merged data hash equals ``prev_hash`` (the
    dataset is byte-identical to what's already published). Pure worker: reads
    no module cache and mutates none — usable from the parent process OR the
    short-lived rebuild subprocess. Returns
    ``(counts, data_hash, category_hashes, published)``.
    """
    import auction_r2_publish  # noqa: WPS433 — backend/ module (shared R2 uploader)
    import process_auction_data as pad  # noqa: WPS433 — backend/ module (write_json/manifest)

    merged = _merge_streaming(_active_sources())
    data_hash = _stable_data_hash(merged)
    category_hashes = _stable_category_hashes(merged)
    counts = {c: len(merged.get(k, [])) for k, c in map_features_merge.CATEGORIES}

    # Change-detection: skip the R2 write when the merged features are the same
    # as what's already published (the proxy re-uploads its full export ~1/min,
    # so most rebuilds carry no new data).
    if data_hash == prev_hash:
        logger.info(
            "[map-features-rebuild] data unchanged (v=%s) — skipping R2 publish.", data_hash
        )
        return counts, data_hash, category_hashes, False

    now_iso = datetime.now(timezone.utc).isoformat()
    with tempfile.TemporaryDirectory(prefix="map-features-rebuild-") as tmp:
        out = Path(tmp)
        files: List[Path] = []
        for doc_key, cat in map_features_merge.CATEGORIES:
            path = out / f"map-features.{cat}.json"
            pad.write_json(path, _feature_file(cat, merged, doc_key, now_iso))
            files.append(path)

        # Manifest version is the stable data hash (not a hash of the timestamped
        # files) so the frontend's ``?v=`` only flips when features actually
        # change — keeping the CDN cache warm between real updates.
        manifest_path = out / "manifest.json"
        pad.write_json(
            manifest_path,
            {
                "version": data_hash,
                "categoryVersions": category_hashes,
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
    # Retire the deprecated combined map-features.json (frontend reads only the
    # per-category files now). Best-effort/idempotent.
    auction_r2_publish.delete_object_from_bucket(
        bucket=settings.MAP_FEATURES_PUBLIC_BUCKET,
        key=f"{settings.MAP_FEATURES_PREFIX}/map-features.json",
    )
    return counts, data_hash, category_hashes, True


def _parse_child_result(
    stdout: str,
) -> "Tuple[Dict[str, int], str, Dict[str, str], bool] | None":
    for line in (stdout or "").splitlines():
        if line.startswith(_RESULT_PREFIX):
            try:
                data = json.loads(line[len(_RESULT_PREFIX):])
            except (json.JSONDecodeError, ValueError):
                return None
            cats = data.get("category_hashes")
            return (
                data.get("counts") or {},
                str(data.get("hash") or ""),
                dict(cats) if isinstance(cats, dict) else {},
                bool(data.get("published")),
            )
    return None


def _run_child_rebuild(
    prev_hash: "str | None",
) -> "Tuple[Dict[str, int], str, Dict[str, str], bool]":
    """Run the merge/publish in a short-lived subprocess so the OS reclaims all
    transient heap on exit (glibc keeps freed arenas in-process otherwise)."""
    env = dict(os.environ)
    env["MAP_FEATURES_REBUILD_RUN_CHILD"] = "1"
    env["MAP_FEATURES_REBUILD_PREV_HASH"] = prev_hash or ""
    proc = subprocess.run(
        [sys.executable, "-m", "app.core.map_features_rebuild"],
        cwd=str(_BACKEND_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=max(60, settings.MAP_FEATURES_REBUILD_MAX_INTERVAL_SECONDS),
    )
    for stream in (proc.stdout, proc.stderr):
        for line in (stream or "").splitlines():
            line = line.rstrip()
            if line and not line.startswith(_RESULT_PREFIX):
                logger.info("%s", line)
    if proc.returncode != 0:
        raise RuntimeError(
            f"rebuild subprocess exit {proc.returncode}: {(proc.stderr or '').strip()[-300:]}"
        )
    result = _parse_child_result(proc.stdout)
    if result is None:
        raise RuntimeError("rebuild subprocess produced no result line")
    return result


def _build_and_publish(force: bool = False) -> Dict[str, int]:
    """Coalescer entry point (runs in an executor thread). Applies the ETag
    short-circuit, then delegates the heavy merge/publish to a subprocess (or
    in-process on fallback / when disabled)."""
    global _last_published_hash, _baseline_seeded, _last_source_fingerprint
    global _last_category_hashes

    active = _active_sources()
    fingerprint = _fingerprint(active)

    # Seed the baselines from whatever is already published (once per process) so
    # a restart never republishes an unchanged dataset.
    if not _baseline_seeded:
        import auction_r2_publish  # noqa: WPS433
        _last_published_hash, _last_category_hashes = _published_state_on_r2(
            auction_r2_publish
        )
        _baseline_seeded = True

    # Cheap short-circuit: no source object changed since our last publish, so a
    # rebuild would reproduce identical output — skip download/parse/merge.
    if (
        not force
        and _last_source_fingerprint is not None
        and fingerprint == _last_source_fingerprint
        and _last_published_hash is not None
    ):
        logger.info("[map-features-rebuild] sources unchanged — skipping rebuild.")
        return {}

    if settings.MAP_FEATURES_REBUILD_SUBPROCESS and not _CHILD:
        try:
            with REBUILD_MEMORY_LOCK:
                counts, data_hash, category_hashes, published = _run_child_rebuild(
                    _last_published_hash
                )
        except Exception as exc:  # noqa: BLE001 — fall back to in-process
            logger.warning(
                "[map-features-rebuild] subprocess failed (%s) — running in-process.", exc
            )
            with REBUILD_MEMORY_LOCK:
                counts, data_hash, category_hashes, published = _do_merge_and_publish(
                    _last_published_hash
                )
    else:
        with REBUILD_MEMORY_LOCK:
            counts, data_hash, category_hashes, published = _do_merge_and_publish(
                _last_published_hash
            )

    _last_published_hash = data_hash
    _last_source_fingerprint = fingerprint

    # A real publish hit R2. Write one audit row per audited category that
    # actually changed (not one per upload), attributed to whoever contributed
    # during the window — so the moderation feed shows only genuine changes.
    # Best-effort — a logging failure must never break the rebuild.
    if published:
        # A publish incorporated these uploads — consume them now (even if only
        # non-audited categories changed) so they can't over-attribute a later
        # change. Attribute each changed audited category to them.
        contributors = _take_contributors()
        prev_cats = _last_category_hashes or {}
        changed = [
            cat
            for cat in AUDITED_CATEGORIES
            if category_hashes.get(cat) != prev_cats.get(cat)
        ]
        _last_category_hashes = category_hashes
        if changed:
            _write_publish_audit(changed, counts, data_hash, contributors)
    return counts


def _write_publish_audit(
    changed: "List[str]",
    counts: Dict[str, int],
    data_hash: str,
    contributors: "List[Tuple[str, Optional[str]]]",
) -> None:
    """One audit row per changed category, attributed to the contributor(s) that
    fed data into the window that produced this publish."""
    actor_key_id, actor_name = _primary_contributor(contributors)
    try:
        from . import database as _db
        for cat in changed:
            _db.insert_map_features_traders_audit(
                action="rebuild_publish",
                category=cat,
                actor_api_key_id=actor_key_id,
                actor_display_name=actor_name,
                count=counts.get(cat),
                published_version=data_hash or None,
            )
    except Exception:
        logger.exception("[map-features-rebuild] failed to write traders audit row")


def _primary_contributor(
    contributors: "List[Tuple[str, Optional[str]]]",
) -> "Tuple[Optional[str], str]":
    """Pick the api_key_id + display name to attribute a publish to: the most
    recent contributor, suffixed with ``(+N more)`` when several uploaded in the
    window. Falls back to ``rebuild`` for admin/forced rebuilds with no upload."""
    if not contributors:
        return None, "rebuild"
    key_id, name = contributors[-1]
    label = name or key_id or "rebuild"
    extra = len(contributors) - 1
    if extra > 0:
        label = f"{label} (+{extra} more)"
    return key_id, label


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
async def rebuild_now(force: bool = False) -> Dict[str, int]:
    """Run a rebuild immediately (single-flight). Awaitable; used by admin ops.
    ``force`` bypasses the ETag short-circuit so it always re-merges."""
    global _build_lock
    if _build_lock is None:
        _build_lock = asyncio.Lock()
    async with _build_lock:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, functools.partial(_build_and_publish, force))


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
            # OS — glibc otherwise keeps it in-arena and RSS only grows. (When the
            # rebuild ran in a subprocess the heavy allocations never touched this
            # process, so RSS stays flat here.)
            gc.collect()
            _malloc_trim()
            cur, lim = _cgroup_mem_mb()
            logger.info(
                "[map-features-rebuild] %s rss=%.0fMB (was %.0fMB) cgroup=%.0f/%.0fMB",
                f"published {result}" if result else "no source changes",
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


# --------------------------------------------------------------------------- #
# Subprocess entry point
# --------------------------------------------------------------------------- #
def _main_child() -> int:
    """Run one merge/publish and print a machine-readable result line. Invoked
    as ``python -m app.core.map_features_rebuild`` by :func:`_run_child_rebuild`
    so the heavy allocations live in a process that exits afterwards."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    prev = os.environ.get("MAP_FEATURES_REBUILD_PREV_HASH") or None
    try:
        counts, data_hash, category_hashes, published = _do_merge_and_publish(prev)
    except Exception as exc:  # noqa: BLE001 — surfaced to the parent via exit code
        sys.stderr.write(f"map-features rebuild child failed: {exc}\n")
        return 1
    print(
        _RESULT_PREFIX
        + json.dumps(
            {
                "counts": counts,
                "hash": data_hash,
                "category_hashes": category_hashes,
                "published": published,
            }
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(_main_child())

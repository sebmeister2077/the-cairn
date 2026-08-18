"""Debounced, single-flight rebuild of the public Auction House artifacts.

Triggered after each contribution ingest (and by the admin rebuild / source
revoke endpoints). Coalesces a burst of contributions into one rebuild: it waits
for a quiet window after the last request, capped by a hard max interval so a
steady stream still refreshes periodically.

A rebuild reads every NON-revoked raw object from the private bucket (plus the
seed), N-way merges them, recomputes listings/summary/items via
``process_auction_data.build_artifacts``, and publishes only those computed
artifacts to the PUBLIC bucket. The raw files never leave the private bucket.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Set, Tuple

from ..config import settings
from . import auction_merge, auction_raw_store, database

logger = logging.getLogger("uvicorn.error")

# backend/ dir holds the standalone process_auction_data.py / auction_r2_publish.py
_BACKEND_DIR = Path(__file__).resolve().parents[2]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

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
    return bool(isinstance(extras, dict) and extras.get("map_features_publish"))


def _active_source_ids(exclude_ids: Set[str]) -> List[str]:
    """Raw object ids to include: the seed + every non-revoked contributor (a key
    with the ``map_features_publish`` permission or a legacy ``auction_contributor``)."""
    out: List[str] = []
    for sid in auction_raw_store.list_raw_ids():
        if sid in exclude_ids:
            continue
        if sid == auction_raw_store.SEED_ID:
            out.append(sid)
            continue
        # Snapshots from the VsAuctionExport mod are stored under "mod"/"mod-<server>"
        # and are trusted (written only by the global-secret authenticated webhook).
        if sid == "mod" or sid.startswith("mod-"):
            out.append(sid)
            continue
        row = database.get_api_key_by_id(sid)
        if not row or row.get("revoked"):
            continue
        if not (row.get("auction_contributor") or _has_publish_permission(row)):
            continue
        out.append(sid)
    return out


def _merge(exclude_ids: Set[str] | None = None) -> List[Dict[str, Any]]:
    exclude_ids = exclude_ids or set()
    sids = _active_source_ids(exclude_ids)
    sources: Iterable[Iterable[Dict[str, Any]]] = [
        auction_merge.iter_json_lines(auction_raw_store.iter_raw_lines(sid))
        for sid in sids
    ]
    merged = auction_merge.merge_events(sources)
    logger.info(
        "[auction-rebuild] merged %d sources -> %d unique auctions",
        len(sids),
        len(merged),
    )
    return merged


def _build_and_publish() -> Dict[str, int]:
    import auction_r2_publish  # noqa: WPS433 — backend/ module
    import process_auction_data as pad  # noqa: WPS433 — backend/ module

    merged = _merge()
    records, summary, items = pad.build_artifacts(merged)

    with tempfile.TemporaryDirectory(prefix="auction-rebuild-") as tmp:
        out = Path(tmp)
        listings_path = out / "listings.json"
        summary_path = out / "summary.json"
        items_path = out / "items.json"
        pad.write_json(listings_path, records)
        pad.write_json(summary_path, summary)
        pad.write_json(items_path, items)
        manifest_path = pad.write_manifest(out, [listings_path, summary_path, items_path])
        auction_r2_publish.publish_files_to_bucket(
            [listings_path, summary_path, items_path, manifest_path],
            bucket=settings.AUCTION_PUBLIC_BUCKET,
            log=lambda m: logger.info("%s", m),
        )
    return {"auctions": len(merged), "listings": len(records), "items": len(items)}


def source_impact(key_id: str) -> Dict[str, int]:
    """Dry-run: how a rebuild WITHOUT ``key_id`` would differ from WITH it.

    Returns counts of auction ids that would be removed (only that source
    provided them) and changed (a different record would win). Does not publish.
    """
    with_src = {r["AuctionId"]: r for r in _merge()}
    without_src = {r["AuctionId"]: r for r in _merge({key_id})}
    removed = set(with_src) - set(without_src)
    changed = sum(
        1 for aid in set(with_src) & set(without_src) if with_src[aid] != without_src[aid]
    )
    return {
        "total_with_source": len(with_src),
        "total_without_source": len(without_src),
        "removed": len(removed),
        "changed": changed,
    }


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
        debounce = max(1, settings.AUCTION_REBUILD_DEBOUNCE_SECONDS)
        max_interval = max(debounce, settings.AUCTION_REBUILD_MAX_INTERVAL_SECONDS)
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
            result = await rebuild_now()
            logger.info("[auction-rebuild] published %s", result)
        except Exception as exc:  # noqa: BLE001 — never crash the worker loop
            logger.warning("[auction-rebuild] failed (will retry on next request): %s", exc)


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

"""GET /api/tops-map-* — Serve the global server map from R2 (globalservermap.db)."""

import json
import threading
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, Response

from ..auth import verify_api_key
from ..rate_limiter import check_rate_limit
from ..core.mapdb import (
    CHUNK_GRID_SIZE,
    DEFAULT_RESOLUTION_LEVEL,
    RESOLUTION_LEVELS,
    get_level_dimension,
    render_map_png,
)
from ..core import generation_tracker, r2_storage, database as db

router = APIRouter()

# Presigned URLs are short-lived enough to mitigate sharing yet long enough to
# survive a browsing session and intermediate caches.
_CHUNK_URL_EXPIRY_SECONDS = 24 * 60 * 60
# Refresh URLs that are within this window of expiring so clients holding the
# old value still have time to use them before the rotation.
_CHUNK_URL_REFRESH_BUFFER_SECONDS = 30 * 60

# In-process cache for level metadata.json. The metadata is immutable for the
# lifetime of a generated level, so re-fetching it from R2 on every request is
# pure overhead. Cleared by `invalidate_level_metadata_cache(level)` when a
# level is regenerated or deleted.
_metadata_cache: dict = {}
_metadata_lock = threading.Lock()

# Throttle for the opportunistic expired-URL cleanup. Running a DELETE on every
# request added a Supabase round-trip to the hot path for no reason — once per
# hour from any request is plenty.
_EXPIRED_CLEANUP_INTERVAL_SECONDS = 60 * 60
_last_expired_cleanup_at: datetime = datetime.fromtimestamp(0, tz=timezone.utc)
_expired_cleanup_lock = threading.Lock()


def invalidate_level_metadata_cache(level: int) -> None:
    """Drop the cached metadata for ``level``. Call when the level is regenerated."""
    with _metadata_lock:
        _metadata_cache.pop(level, None)


def _read_db() -> bytes:
    """Download globalservermap.db from R2."""
    return r2_storage.download_bytes(r2_storage.COMBINED_DB_KEY)


def _level_metadata(level: int) -> dict:
    """Load level metadata.json from R2 (geometry needed for stitching).

    Cached in process memory after the first successful fetch; invalidated
    via ``invalidate_level_metadata_cache(level)`` when the level changes.
    """
    cached = _metadata_cache.get(level)
    if cached is not None:
        return cached
    raw = r2_storage.download_bytes(r2_storage.tops_map_level_metadata_key(level))
    parsed = json.loads(raw.decode("utf-8"))
    with _metadata_lock:
        _metadata_cache[level] = parsed
    return parsed


def _maybe_cleanup_expired_urls() -> None:
    """Run the expired-URL cleanup at most once per hour across all requests."""
    global _last_expired_cleanup_at
    now = datetime.now(timezone.utc)
    if (now - _last_expired_cleanup_at).total_seconds() < _EXPIRED_CLEANUP_INTERVAL_SECONDS:
        return
    with _expired_cleanup_lock:
        if (now - _last_expired_cleanup_at).total_seconds() < _EXPIRED_CLEANUP_INTERVAL_SECONDS:
            return
        _last_expired_cleanup_at = now
    try:
        db.delete_expired_chunk_urls()
    except Exception:
        # Cleanup is best-effort; don't break the request if Supabase hiccups.
        pass


def _build_chunk_urls(level: int) -> tuple:
    """Return ``(chunks, earliest_expires_at)`` for every chunk in the level grid.

    Reuses presigned URLs cached in the database when they are still valid.
    Missing or near-expiring URLs are regenerated and persisted. ``earliest_expires_at``
    is the soonest expiry across the returned URLs (or ``None`` if the level has no
    chunks yet) so the frontend knows when to refetch.
    """
    # Opportunistic cleanup so the table doesn't accumulate dead rows. Throttled
    # so this isn't a Supabase round-trip on every request.
    _maybe_cleanup_expired_urls()

    now = datetime.now(timezone.utc)
    refresh_threshold = now + timedelta(seconds=_CHUNK_URL_REFRESH_BUFFER_SECONDS)
    cached = db.get_cached_chunk_urls(level, min_expires_at=refresh_threshold)

    out = []
    new_rows = []
    earliest = None
    for cy in range(CHUNK_GRID_SIZE):
        for cx in range(CHUNK_GRID_SIZE):
            entry = cached.get((cx, cy))
            if entry is not None:
                url = entry["url"]
                expires_at = entry["expires_at"]
            else:
                key = r2_storage.tops_map_level_chunk_key(level, cx, cy)
                url = r2_storage.generate_presigned_download_url(
                    key,
                    expires_seconds=_CHUNK_URL_EXPIRY_SECONDS,
                )
                if not url:
                    continue
                expires_at = now + timedelta(seconds=_CHUNK_URL_EXPIRY_SECONDS)
                new_rows.append({"cx": cx, "cy": cy, "url": url, "expires_at": expires_at})
            out.append({
                "cx": cx,
                "cy": cy,
                "url": url,
                "expires_at": expires_at.isoformat(),
            })
            if earliest is None or expires_at < earliest:
                earliest = expires_at

    if new_rows:
        try:
            db.upsert_chunk_urls(level, new_rows)
        except Exception:
            # Caching is a best-effort optimisation — never fail the request.
            pass

    return out, earliest


def _available_resolution_levels() -> list:
    """Return sorted list of {level, max_dimension, status, generated_at}
    for levels that have been generated (or are generating)."""
    status = generation_tracker.get_status().get("levels", {})
    out = []
    for lvl, max_dim in sorted(RESOLUTION_LEVELS.items()):
        entry = status.get(str(lvl), {})
        out.append({
            "level": lvl,
            "max_dimension": max_dim,
            "status": entry.get("status", "not_generated"),
            "generated_at": entry.get("generated_at"),
            "size_bytes": entry.get("size_bytes"),
            "progress": entry.get("progress", 0),
        })
    return out


@router.get("/tops-map-stats")
def tops_map_stats(api_key: str = Depends(verify_api_key)):
    check_rate_limit(api_key)
    stats = db.get_tops_map_stats()
    if not stats:
        return JSONResponse(
            status_code=503,
            content={
                "detail": "TOPS map stats cache is not ready. Run pregenerate_tops_map_cache.py first.",
            },
        )

    levels_meta = _available_resolution_levels()
    available = [m for m in levels_meta if m["status"] == "complete"]

    # Choose default: prefer DEFAULT_RESOLUTION_LEVEL if generated, else
    # nearest lower available, else lowest available.
    default_level = None
    if available:
        completed_levels = [m["level"] for m in available]
        if DEFAULT_RESOLUTION_LEVEL in completed_levels:
            default_level = DEFAULT_RESOLUTION_LEVEL
        else:
            lower = [lvl for lvl in completed_levels if lvl <= DEFAULT_RESOLUTION_LEVEL]
            default_level = max(lower) if lower else min(completed_levels)

    return {
        **stats,
        "default_level": default_level,
        "resolutions": levels_meta,
    }


@router.get("/tops-map-level/{level}")
def tops_map_level(level: int, api_key: str = Depends(verify_api_key)):
    """Return level metadata + presigned URLs for every chunk in the grid.

    The frontend stitches the chunks together client-side. If the level isn't
    fully generated yet, we still return whatever chunks exist so the UI can
    render a partial map progressively.
    """
    check_rate_limit(api_key)
    if level not in RESOLUTION_LEVELS:
        return JSONResponse(status_code=400, content={"detail": "Unknown level"})

    entry = generation_tracker.get_level_status(level)
    try:
        metadata = _level_metadata(level)
    except FileNotFoundError:
        return JSONResponse(
            status_code=404,
            content={
                "detail": "Level not generated",
                "status": entry.get("status", "not_generated"),
                "progress": entry.get("progress", 0),
            },
        )

    chunks, earliest_expires_at = _build_chunk_urls(level)
    return {
        "level": level,
        "max_dimension": get_level_dimension(level),
        "status": entry.get("status", "not_generated"),
        "progress": entry.get("progress", 0),
        "generated_at": entry.get("generated_at"),
        "size_bytes": entry.get("size_bytes"),
        "chunk_grid": CHUNK_GRID_SIZE,
        "image_w": metadata.get("image_w"),
        "image_h": metadata.get("image_h"),
        "chunk_w": metadata.get("chunk_w"),
        "chunk_h": metadata.get("chunk_h"),
        "scale": metadata.get("scale"),
        "width_blocks": metadata.get("width_blocks"),
        "height_blocks": metadata.get("height_blocks"),
        "start_x": metadata.get("start_x"),
        "start_z": metadata.get("start_z"),
        "chunks": chunks,
        "url_expires_in": _CHUNK_URL_EXPIRY_SECONDS,
        "expires_at": earliest_expires_at.isoformat() if earliest_expires_at else None,
    }


@router.get("/tops-map-render")
def tops_map_render(
    max_dimension: int = 4096,
    api_key: str = Depends(verify_api_key),
):
    """Legacy single-PNG endpoint.

    Kept for backwards compatibility (e.g. CLI users / old clients). The TOPS
    map page now fetches chunks and stitches them in the browser. This route
    only renders on demand from the source DB; no cached assembled PNG is
    stored anymore.
    """
    check_rate_limit(api_key)
    clamped_dim = max(256, min(max_dimension, 16384))

    try:
        db_bytes = _read_db()
        png_bytes = render_map_png(db_bytes, max_dimension=clamped_dim)
    except FileNotFoundError as e:
        return JSONResponse(status_code=404, content={"detail": str(e)})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"detail": str(e)})

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            "Content-Disposition": "inline; filename=tops-map.png",
            "X-Map-Cache": "miss",
        },
    )

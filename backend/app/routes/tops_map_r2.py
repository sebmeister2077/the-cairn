"""GET /api/tops-map-* — Serve the global server map from R2 (globalservermap.db)."""

import json
import threading
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, Response

from ..auth import verify_api_key
from ..rate_limiter import check_rate_limit
from ..core.mapdb import (
    DEFAULT_RESOLUTION_LEVEL,
    RESOLUTION_LEVELS,
    get_chunk_grid_size,
    get_level_dimension,
    render_map_png,
)
from ..core import generation_tracker, r2_storage, database as db

router = APIRouter()

# Presigned URLs live for the S3v4 maximum (7 days) so daily visitors almost
# never trigger a re-sign round-trip. Cached in Postgres via
# ``tops_map_chunk_urls`` and refreshed within the buffer below.
_CHUNK_URL_EXPIRY_SECONDS = 7 * 24 * 60 * 60
# Refresh URLs that are within this window of expiring so clients holding the
# old value still have time to use them before the rotation.
_CHUNK_URL_REFRESH_BUFFER_SECONDS = 30 * 60

# In-process cache for level metadata.json. The metadata is immutable for the
# lifetime of a generated level, so re-fetching it from R2 on every request is
# pure overhead. Cleared by `invalidate_level_metadata_cache(level)` when a
# level is regenerated or deleted *in this process*.
#
# Cross-process invalidation: when the R2 object is rewritten by another
# process (e.g. a local admin running refresh-metadata against the prod R2
# bucket), this process never sees the `invalidate_level_metadata_cache` call
# and would otherwise serve its stale parsed copy forever. To prevent that we
# also revalidate the ETag against R2 at most once every
# `_METADATA_REVALIDATE_AFTER_SECONDS`. A HEAD that matches the cached ETag
# costs a single cheap round-trip and lets us keep serving the parsed dict.
# A mismatch triggers a re-download.
_metadata_cache: dict = {}
_metadata_lock = threading.Lock()
_METADATA_REVALIDATE_AFTER_SECONDS = 60

# Per-level pointer cache: maps ``level -> {"live": str | None,
# "previous": str | None, "etag": str, "checked_at": datetime}``. The
# pointer file (``cache/tops-map-level{N}/CURRENT.json``) names the live
# bundle subprefix. Same revalidation strategy as the metadata cache so a
# pointer flip done by another process is picked up within ~60s without
# the request path paying the HEAD cost more than once per window.
_pointer_cache: dict = {}
_pointer_lock = threading.Lock()
_POINTER_REVALIDATE_AFTER_SECONDS = 30

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


def invalidate_level_pointer_cache(level: Optional[int] = None) -> None:
    """Drop the cached pointer file for ``level`` (or every level when ``None``).
    Call after activate / rollback so the next request reads the fresh pointer.
    Also drops the metadata cache because a pointer flip means the level's
    metadata key has moved to a different subprefix.
    """
    with _pointer_lock:
        if level is None:
            _pointer_cache.clear()
        else:
            _pointer_cache.pop(level, None)
    if level is None:
        with _metadata_lock:
            _metadata_cache.clear()
    else:
        invalidate_level_metadata_cache(level)


def _read_level_pointer(level: int) -> dict:
    """Return ``{"live": str | None, "previous": str | None}`` from R2.
    Missing pointer is treated as ``{"live": None, "previous": None}`` so
    existing deployments keep serving the legacy unprefixed layout.
    Cached for ``_POINTER_REVALIDATE_AFTER_SECONDS`` with ETag revalidation
    so a flip done in another process is observed promptly.
    """
    key = r2_storage.tops_map_level_pointer_key(level)
    now = datetime.now(timezone.utc)
    cached = _pointer_cache.get(level)
    if cached is not None:
        if (now - cached["checked_at"]).total_seconds() < _POINTER_REVALIDATE_AFTER_SECONDS:
            return cached["parsed"]
        try:
            current_etag = r2_storage.get_object_etag(key)
        except FileNotFoundError:
            # Pointer was deleted — fall back to legacy.
            parsed = {"live": None, "previous": None}
            with _pointer_lock:
                _pointer_cache[level] = {
                    "parsed": parsed, "etag": "", "checked_at": now,
                }
            return parsed
        except Exception:
            return cached["parsed"]
        if current_etag and current_etag == cached.get("etag"):
            with _pointer_lock:
                entry = _pointer_cache.get(level)
                if entry is not None:
                    entry["checked_at"] = now
            return cached["parsed"]
        # ETag changed — also drop the cached metadata since the version
        # subprefix has moved.
        invalidate_level_metadata_cache(level)
    try:
        raw = r2_storage.download_bytes(key)
    except FileNotFoundError:
        parsed = {"live": None, "previous": None}
        etag = ""
    else:
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            parsed = {"live": None, "previous": None}
        try:
            etag = r2_storage.get_object_etag(key)
        except Exception:
            etag = ""
    parsed = {
        "live": parsed.get("live") if isinstance(parsed, dict) else None,
        "previous": parsed.get("previous") if isinstance(parsed, dict) else None,
    }
    with _pointer_lock:
        _pointer_cache[level] = {
            "parsed": parsed, "etag": etag, "checked_at": now,
        }
    return parsed


def _live_version(level: int):
    """Resolve the version subprefix to serve for ``level``. ``None`` means
    the legacy unprefixed layout."""
    ptr = _read_level_pointer(level)
    live = ptr.get("live")
    if not live or live == r2_storage.TOPS_MAP_LEGACY_VERSION:
        return None
    return live


def _read_db() -> bytes:
    """Download globalservermap.db from R2."""
    return r2_storage.download_bytes(r2_storage.COMBINED_DB_KEY)


def _level_metadata(level: int) -> dict:
    """Load level metadata.json from R2 (geometry needed for stitching).

    Cached in process memory. The cached entry is revalidated against R2's
    ETag at most once per ``_METADATA_REVALIDATE_AFTER_SECONDS`` so an
    out-of-process rewrite (e.g. admin refresh-metadata hitting R2 from a
    different host) can't leave us serving stale geometry indefinitely.
    Call ``invalidate_level_metadata_cache(level)`` for immediate eviction
    inside this process.
    """
    version = _live_version(level)
    key = r2_storage.tops_map_level_metadata_key(level, version=version)
    now = datetime.now(timezone.utc)
    cached = _metadata_cache.get(level)
    if cached is not None:
        if (now - cached["checked_at"]).total_seconds() < _METADATA_REVALIDATE_AFTER_SECONDS:
            return cached["parsed"]
        # Stale enough to revalidate. HEAD R2 for the current ETag; if it
        # matches what we cached, the parsed copy is still valid — just bump
        # the freshness timestamp and reuse it.
        try:
            current_etag = r2_storage.get_object_etag(key)
        except Exception:
            # Network blip — keep serving the cached copy rather than failing
            # the request; we'll try to revalidate again on the next call.
            return cached["parsed"]
        if current_etag and current_etag == cached.get("etag"):
            with _metadata_lock:
                entry = _metadata_cache.get(level)
                if entry is not None:
                    entry["checked_at"] = now
            return cached["parsed"]
        # ETag changed — fall through to re-download.
    raw = r2_storage.download_bytes(key)
    parsed = json.loads(raw.decode("utf-8"))
    try:
        etag = r2_storage.get_object_etag(key)
    except Exception:
        etag = ""
    with _metadata_lock:
        _metadata_cache[level] = {
            "parsed": parsed,
            "etag": etag,
            "checked_at": datetime.now(timezone.utc),
        }
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

    grid = get_chunk_grid_size(level)
    version = _live_version(level)

    out = []
    new_rows = []
    earliest = None

    # Figure out which chunks need a fresh presign. If any are missing from the
    # cache, do a single LIST against the level prefix instead of doing a HEAD
    # per chunk — one R2 round-trip vs. up to grid².
    missing_coords = [
        (cx, cy)
        for cy in range(grid)
        for cx in range(grid)
        if (cx, cy) not in cached
    ]
    existing_keys: set = set()
    if missing_coords:
        prefix = (
            f"cache/tops-map-level{level}/"
            f"{r2_storage._tops_map_version_subpath(version)}"
        )
        try:
            existing_keys = set(r2_storage.list_keys_with_prefix(prefix))
        except Exception:
            # Fall back to per-chunk HEAD checks if listing fails.
            existing_keys = None  # type: ignore[assignment]

    for cy in range(grid):
        for cx in range(grid):
            entry = cached.get((cx, cy))
            if entry is not None:
                url = entry["url"]
                expires_at = entry["expires_at"]
            else:
                key = r2_storage.tops_map_level_chunk_key(
                    level, cx, cy, version=version,
                )
                if existing_keys is not None and key not in existing_keys:
                    continue
                url = r2_storage.generate_presigned_download_url(
                    key,
                    expires_seconds=_CHUNK_URL_EXPIRY_SECONDS,
                    verify_exists=existing_keys is None,
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
        "chunk_grid": metadata.get("chunk_grid", get_chunk_grid_size(level)),
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

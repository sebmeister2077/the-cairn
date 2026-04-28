"""Feature-flag helper with a small in-process cache.

Flags live in the Supabase ``feature_flags`` table (see
``database.py``). Reads are cached for ``CACHE_TTL_SECONDS`` to avoid
hammering Supabase on hot paths. Writes go via
``database.set_feature_flag`` and bypass the cache, but the cache will
self-refresh within the TTL.
"""

import threading
import time
from typing import Optional

from . import database as db


CACHE_TTL_SECONDS = 30

_lock = threading.Lock()
_cache: dict = {}  # key -> (enabled: bool, fetched_at: float)


def _read_through(key: str) -> bool:
    row = db.get_feature_flag(key)
    return bool(row and row.get("enabled"))


def is_feature_enabled(key: str) -> bool:
    """Return True if flag ``key`` is enabled. Defaults to False on missing row."""
    now = time.monotonic()
    with _lock:
        cached = _cache.get(key)
        if cached and (now - cached[1]) < CACHE_TTL_SECONDS:
            return cached[0]
    try:
        enabled = _read_through(key)
    except Exception:
        # On DB hiccup, prefer the last known value rather than flipping a
        # gated feature off mid-flight.
        with _lock:
            cached = _cache.get(key)
            if cached:
                return cached[0]
        return False
    with _lock:
        _cache[key] = (enabled, now)
    return enabled


def is_feature_enabled_default(key: str, default: bool) -> bool:
    """Like :func:`is_feature_enabled`, but lets the caller pick the value
    used when the row is missing or the DB is unreachable. Used by the
    operational kill-switch flags (``uploads_enabled``,
    ``registration_enabled``) where the safe-on-failure value is True so
    a transient DB blip doesn't take the public site offline.
    """
    now = time.monotonic()
    with _lock:
        cached = _cache.get(key)
        if cached and (now - cached[1]) < CACHE_TTL_SECONDS:
            return cached[0]
    try:
        row = db.get_feature_flag(key)
    except Exception:
        with _lock:
            cached = _cache.get(key)
            if cached:
                return cached[0]
        return default
    enabled = bool(row["enabled"]) if row else default
    with _lock:
        _cache[key] = (enabled, now)
    return enabled


def invalidate(key: Optional[str] = None) -> None:
    """Drop a single flag (or the whole cache) so the next read is fresh."""
    with _lock:
        if key is None:
            _cache.clear()
        else:
            _cache.pop(key, None)

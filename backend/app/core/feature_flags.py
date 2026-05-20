"""Feature-flag helper with a small in-process cache.

Flags live in the Supabase ``feature_flags`` table (see
``database.py``). Reads are cached for ``CACHE_TTL_SECONDS`` to avoid
hammering Supabase on hot paths. Writes go via
``database.set_feature_flag`` and bypass the cache, but the cache will
self-refresh within the TTL.
"""

import os
import threading
import time
from typing import Optional, Tuple

from . import database as db


CACHE_TTL_SECONDS = 30

_lock = threading.Lock()
# key -> (enabled: bool, value_int: Optional[int], fetched_at: float)
_cache: dict = {}


def _read_through(key: str) -> Tuple[bool, Optional[int]]:
    row = db.get_feature_flag(key)
    if not row:
        return False, None
    raw = row.get("value_int")
    vi = int(raw) if raw is not None else None
    return bool(row.get("enabled")), vi


def is_feature_enabled(key: str) -> bool:
    """Return True if flag ``key`` is enabled. Defaults to False on missing row."""
    now = time.monotonic()
    with _lock:
        cached = _cache.get(key)
        if cached and (now - cached[2]) < CACHE_TTL_SECONDS:
            return cached[0]
    try:
        enabled, value_int = _read_through(key)
    except Exception:
        # On DB hiccup, prefer the last known value rather than flipping a
        # gated feature off mid-flight.
        with _lock:
            cached = _cache.get(key)
            if cached:
                return cached[0]
        return False
    with _lock:
        _cache[key] = (enabled, value_int, now)
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
        if cached and (now - cached[2]) < CACHE_TTL_SECONDS:
            return cached[0]
    try:
        row = db.get_feature_flag(key)
    except Exception:
        with _lock:
            cached = _cache.get(key)
            if cached:
                return cached[0]
        return default
    if row:
        enabled = bool(row["enabled"])
        raw = row.get("value_int")
        value_int = int(raw) if raw is not None else None
    else:
        enabled = default
        value_int = None
    with _lock:
        _cache[key] = (enabled, value_int, now)
    return enabled


def get_int(key: str, default: int) -> int:
    """Return the admin-set numeric override for ``key``, or ``default`` if
    no row exists, the override is NULL, the DB is unreachable, or the
    stored value is negative (treated as "unset").

    Use this for admin-tunable quotas (per-day submission caps, max batch
    sizes, dedupe radii, cooldowns). The corresponding ``feature_flags``
    row only needs to exist for the override to take effect — the boolean
    ``enabled`` column is unused. Same 30 s in-process cache as the
    boolean readers; updates from the admin page propagate within the TTL.
    """
    now = time.monotonic()
    with _lock:
        cached = _cache.get(key)
        if cached and (now - cached[2]) < CACHE_TTL_SECONDS:
            vi = cached[1]
            return vi if (vi is not None and vi >= 0) else default
    try:
        enabled, value_int = _read_through(key)
    except Exception:
        # DB hiccup: prefer the last known cached override; otherwise fall
        # back to the caller's default rather than 0-ing the quota.
        with _lock:
            cached = _cache.get(key)
            if cached:
                vi = cached[1]
                return vi if (vi is not None and vi >= 0) else default
        return default
    with _lock:
        _cache[key] = (enabled, value_int, now)
    return value_int if (value_int is not None and value_int >= 0) else default


def invalidate(key: Optional[str] = None) -> None:
    """Drop a single flag (or the whole cache) so the next read is fresh."""
    with _lock:
        if key is None:
            _cache.clear()
        else:
            _cache.pop(key, None)


def is_heavy_compute_allowed() -> bool:
    """Whether heavy background workers (validation, match score, preview
    rendering, …) are permitted to spawn / run.

    Resolution order:

    1. ``HEAVY_COMPUTE_LOCAL_OVERRIDE`` env var — if set to a truthy value
       (``1``/``true``/``yes``/``on``, case-insensitive) the kill switch is
       bypassed unconditionally. Intended for developers running the
       backend locally against the prod database: the deployed Render
       instance never sets this var so its non-admin users still respect
       the flag.
    2. ``heavy_compute_enabled`` feature flag (default True when missing).
    """
    raw = os.environ.get("HEAVY_COMPUTE_LOCAL_OVERRIDE", "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    return is_feature_enabled_default("heavy_compute_enabled", True)


def is_auto_regen_after_approval_enabled() -> bool:
    """Whether contribution approve / revert should auto-kick a map-cache
    regeneration. Default True so behaviour is unchanged when the row is
    missing. Flip OFF to suppress the post-merge regen entirely — useful
    when the small production server cannot afford the rerender even with
    ``heavy_compute_enabled`` ON, and an admin will trigger regeneration
    manually from the TOPS map admin panel.
    """
    return is_feature_enabled_default("auto_regen_after_approval", True)

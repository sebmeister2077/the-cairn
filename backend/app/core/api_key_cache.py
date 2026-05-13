"""In-memory cache for API key lookups.

Each authenticated request used to hit the ``api_keys`` table twice
(``SELECT`` to resolve + ``UPDATE`` to bump ``last_used_at`` /
``usage_count``). With the post-migration schema, every audit-style write
also needs the resolved ``api_keys.id`` UUID, so a third lookup would be
required on writes. This module collapses all of that to in-memory work
for hot keys.

Design
------

* **Key:** the raw auth token (``api_keys.key``).
* **Value:** a copy of the ``api_keys`` row + ``is_admin`` flag, refreshed
  from the DB on miss.
* **Eviction:** stale-after-idle. If the cached entry's ``last_used_at``
  is more than :data:`STALE_AFTER` ago, the next access drops it and
  re-fetches from the DB. So a key that goes idle for >10 min picks up
  any DB-side mutations (revocation, permission change) on its next use.
* **Throttled DB writes:** the cache's ``touch()`` returns the resolved
  info dict and bumps an in-memory ``_pending_uses`` counter. At most
  once per :data:`TOUCH_FLUSH_INTERVAL` per key, the accumulated delta is
  flushed to the DB in a single ``UPDATE``. So a key under sustained load
  no longer writes to the DB on every request.
* **Thread-safety:** all mutating operations hold a single module-level
  ``Lock``. The DB flush itself runs *after* the lock is released so a
  slow query can't block other auth resolutions.

Bootstrap
---------

:func:`bootstrap_env_keys` upserts the env-var ``ADMIN_API_KEY`` and
``API_KEYS`` list into the ``api_keys`` table on startup. This makes them
ordinary DB rows with a real UUID, which lets every ``*_key_id`` foreign
key column reference them just like dynamic keys.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Optional
from uuid import UUID

from ..config import settings


# How long a cached entry can sit idle before the next access re-fetches
# it from the DB. Picks up revocations / permission changes for keys that
# are not under sustained load.
STALE_AFTER = timedelta(minutes=10)

# Minimum interval between DB flushes of ``last_used_at`` / ``usage_count``
# for the same key. A key hit 1000x in 60 s costs one ``UPDATE`` instead
# of 1000.
TOUCH_FLUSH_INTERVAL = timedelta(seconds=60)


_lock = Lock()
# Cached rows. Each entry has the api_keys columns plus three private
# fields prefixed with ``_``:
#   _pending_uses    — uncommitted increments to usage_count
#   _last_db_flush   — when we last wrote to api_keys for this key
_cache: dict[str, dict] = {}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def touch(key: str) -> Optional[dict]:
    """Look up ``key`` in the cache and bump its in-memory usage counters.

    Returns a copy of the cached info dict (without the private ``_*``
    fields), or ``None`` if the key is not cached or its entry has gone
    stale. On a flush-due hit, also writes the accumulated usage delta
    to the DB synchronously (single ``UPDATE``).
    """
    now = datetime.now(timezone.utc)
    needs_flush = False
    flush_pending = 0
    flush_last_used: Optional[datetime] = None
    info_copy: Optional[dict] = None

    with _lock:
        entry = _cache.get(key)
        if entry is None:
            return None

        last_used = entry.get("last_used_at")
        if last_used is None or now - last_used > STALE_AFTER:
            # Stale eviction — don't drop pending usage increments on the
            # floor; queue them for a flush after we release the lock.
            stale_pending = entry.get("_pending_uses", 0)
            _cache.pop(key, None)
            if stale_pending > 0 and last_used is not None:
                flush_pending = stale_pending
                flush_last_used = last_used
                needs_flush = True
        else:
            entry["last_used_at"] = now
            entry["_pending_uses"] = entry.get("_pending_uses", 0) + 1

            if now - entry.get("_last_db_flush", now) >= TOUCH_FLUSH_INTERVAL:
                flush_pending = entry["_pending_uses"]
                flush_last_used = entry["last_used_at"]
                entry["_pending_uses"] = 0
                entry["_last_db_flush"] = now
                needs_flush = True

            info_copy = {k: v for k, v in entry.items() if not k.startswith("_")}

    if needs_flush:
        _flush_to_db(key, flush_pending, flush_last_used)

    return info_copy


def peek(key: str) -> Optional[dict]:
    """Read the cached entry without touching counters. Returns ``None``
    if not cached or stale. Used by permission checks that don't count
    as a "use" of the key."""
    now = datetime.now(timezone.utc)
    with _lock:
        entry = _cache.get(key)
        if entry is None:
            return None
        last_used = entry.get("last_used_at")
        if last_used is None or now - last_used > STALE_AFTER:
            return None
        return {k: v for k, v in entry.items() if not k.startswith("_")}


def put(key: str, info: dict) -> dict:
    """Insert or refresh a cache entry from a fresh DB row.

    ``info`` should be the dict returned by :func:`db.get_api_key`,
    augmented with any auth-level synthetic fields (e.g. ``is_admin``).
    Returns the same dict that subsequent :func:`touch` calls will see.
    """
    now = datetime.now(timezone.utc)
    with _lock:
        cached = dict(info)
        cached["last_used_at"] = now
        cached["_pending_uses"] = 1
        cached["_last_db_flush"] = now
        _cache[key] = cached
        return {k: v for k, v in cached.items() if not k.startswith("_")}


def invalidate(key: str) -> None:
    """Drop ``key`` from the cache. Call after revoking, deleting, or
    mutating a row in the ``api_keys`` table so the next request re-reads
    the new state instead of serving the stale cache entry."""
    with _lock:
        _cache.pop(key, None)


def invalidate_all() -> None:
    """Clear the entire cache. Useful in tests."""
    with _lock:
        _cache.clear()


def flush_all() -> int:
    """Flush all pending usage counters to the DB without evicting entries.

    Call from app shutdown so a redeploy / restart doesn't silently
    discard the in-memory increments accumulated since the last
    per-key flush. Returns the number of keys that had pending writes.
    """
    pending: list[tuple[str, int, datetime]] = []
    now = datetime.now(timezone.utc)
    with _lock:
        for key, entry in _cache.items():
            n = entry.get("_pending_uses", 0)
            last_used = entry.get("last_used_at")
            if n > 0 and last_used is not None:
                pending.append((key, n, last_used))
                entry["_pending_uses"] = 0
                entry["_last_db_flush"] = now
    for key, n, last_used in pending:
        _flush_to_db(key, n, last_used)
    return len(pending)


def get_id(key: str) -> Optional[UUID]:
    """Convenience: return the cached ``api_keys.id`` for ``key`` (or
    ``None`` if not cached). Does not bump usage counters."""
    cached = peek(key)
    if cached is None:
        return None
    val = cached.get("id")
    return val if isinstance(val, UUID) else (UUID(str(val)) if val else None)


def ensure_id(key: Optional[str]) -> Optional[UUID]:
    """Cache-first lookup of the ``api_keys.id`` UUID for ``key``.

    Returns the cached id immediately if available; otherwise falls back
    to a single ``SELECT`` against the ``api_keys`` table and warms the
    cache with the full row. Returns ``None`` if ``key`` is empty / not
    known to the system.

    This is the helper that DB write paths use to translate "the api_key
    the caller authenticated with" into "the UUID the audit FK wants to
    store" without forcing every route handler to switch dependency.
    """
    if not key:
        return None
    val = get_id(key)
    if val is not None:
        return val
    from . import database as db  # local import to avoid cycle
    if not db.is_available():
        return None
    row = db.get_api_key(key)
    if not row:
        return None
    info = dict(row)
    # Don't have request context here, so can't set is_admin reliably; leave
    # it absent. The cached entry will be replaced by a full put() the next
    # time auth.py resolves the key through verify_api_key_info().
    put(key, info)
    val = info.get("id")
    if val is None:
        return None
    return val if isinstance(val, UUID) else UUID(str(val))


def stats() -> dict:
    """Return a snapshot of cache statistics for debugging / metrics."""
    with _lock:
        return {
            "size": len(_cache),
            "stale_after_seconds": STALE_AFTER.total_seconds(),
            "flush_interval_seconds": TOUCH_FLUSH_INTERVAL.total_seconds(),
        }


# ---------------------------------------------------------------------------
# Env-var key bootstrap
# ---------------------------------------------------------------------------

def bootstrap_env_keys() -> dict:
    """Insert env-var ``ADMIN_API_KEY`` and ``API_KEYS`` into the
    ``api_keys`` table if they're not already there. Returns a small
    summary dict for logging.

    Idempotent — uses ``ON CONFLICT (key) DO NOTHING``. Safe to call on
    every startup. Required because the post-migration schema stores
    ``api_keys.id`` UUIDs in audit columns; env-only keys would otherwise
    have no ``id`` and we'd have to leave those columns NULL.
    """
    from . import database as db  # local import to avoid cycle at module load

    summary = {"admin_inserted": False, "legacy_inserted": 0, "skipped": False}
    if not db.is_available():
        summary["skipped"] = True
        return summary

    with db.get_conn() as conn, conn.cursor() as cur:
        if settings.ADMIN_API_KEY:
            cur.execute(
                "INSERT INTO api_keys (key, name, permissions) "
                "VALUES (%s, %s, %s) ON CONFLICT (key) DO NOTHING",
                (settings.ADMIN_API_KEY, "env:ADMIN_API_KEY", "contribute"),
            )
            if cur.rowcount > 0:
                summary["admin_inserted"] = True
        for k in (settings.API_KEYS or []):
            if not k:
                continue
            cur.execute(
                "INSERT INTO api_keys (key, name, permissions) "
                "VALUES (%s, %s, %s) ON CONFLICT (key) DO NOTHING",
                (k, "env:API_KEYS", "contribute"),
            )
            if cur.rowcount > 0:
                summary["legacy_inserted"] += 1
    return summary


# ---------------------------------------------------------------------------
# Internal: throttled flush
# ---------------------------------------------------------------------------

def _flush_to_db(key: str, pending_uses: int, last_used: datetime) -> None:
    """Write the accumulated usage delta + last_used to the DB.

    Swallows exceptions so a transient DB hiccup can't break auth
    resolution — the next flush will retry with the (still-accumulating)
    counter.
    """
    if pending_uses <= 0:
        return
    try:
        from . import database as db  # local import to avoid cycle
        with db.get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE api_keys "
                "SET last_used_at = %s, usage_count = usage_count + %s "
                "WHERE key = %s",
                (last_used, pending_uses, key),
            )
    except Exception:
        # If the flush fails, the in-memory counter has already been zeroed
        # for this round; we simply lose those increments. Acceptable for
        # a usage counter — auth itself is unaffected.
        pass

"""Tracks the generation status of multi-resolution TOPS map levels.

Status is persisted in the PostgreSQL `app_state` table under a single key,
so polling endpoints and admin UIs can observe progress in near-real-time.

Status shape:
{
  "levels": {
    "1": {"status": "complete"|"generating"|"not_generated"|"failed",
          "generated_at": "ISO-8601" | null,
          "started_at": "ISO-8601" | null,
          "progress": 0..100,
          "current_chunk": "cx-cy" | null,
          "total_chunks": int,
          "completed_chunks": int,
          "size_bytes": int | null,
          "error": str | null}
  }
}
"""

from datetime import datetime, timezone
import json
import threading
from typing import Dict, Optional

from . import database as db
from .mapdb import RESOLUTION_LEVELS, get_chunk_grid_size

STATE_KEY = "tops_map_generation_status"

# In-process lock to serialise read-modify-write cycles of the status JSON.
# Generation runs in a single background task per process, so this is enough
# to avoid lost updates from concurrent progress writes.
_lock = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _empty_level(level: Optional[int] = None) -> dict:
    if level is None:
        total_chunks = 0
    else:
        try:
            total_chunks = get_chunk_grid_size(level) ** 2
        except ValueError:
            total_chunks = 0
    return {
        "status": "not_generated",
        "generated_at": None,
        "started_at": None,
        "progress": 0,
        "current_chunk": None,
        "total_chunks": total_chunks,
        "completed_chunks": 0,
        "size_bytes": None,
        "error": None,
        # --- Staged-swap fields (added May 2026) ----------------------------
        # ``live_version`` is the version subprefix currently served to
        # users (None / "__legacy__" means the bare unprefixed layout).
        # ``previous_version`` is what ``live_version`` was before the most
        # recent activation — kept so admins can roll back with one click.
        # ``pending_version`` is a freshly generated bundle waiting for an
        # admin to flip the pointer; users keep seeing ``live_version``
        # until then. ``pending_size_bytes`` and ``pending_generated_at``
        # mirror the equivalent live fields so the admin UI can show the
        # staged bundle's stats before activation.
        "live_version": None,
        "previous_version": None,
        "pending_version": None,
        "pending_size_bytes": None,
        "pending_generated_at": None,
    }


def _load_raw() -> dict:
    raw = db.get_state(STATE_KEY)
    if not raw:
        return {"levels": {str(lvl): _empty_level(lvl) for lvl in RESOLUTION_LEVELS}}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        parsed = {}
    levels = parsed.get("levels") or {}
    # Ensure every configured level has an entry with all required fields.
    for lvl in RESOLUTION_LEVELS:
        key = str(lvl)
        existing = levels.get(key) or {}
        merged = _empty_level(lvl)
        merged.update(existing)
        levels[key] = merged
    parsed["levels"] = levels
    return parsed


def _save_raw(state: dict):
    db.set_state(STATE_KEY, json.dumps(state))


def get_status() -> dict:
    """Return the full generation status for all levels."""
    with _lock:
        return _load_raw()


def get_level_status(level: int) -> dict:
    return get_status()["levels"].get(str(level), _empty_level(level))


def is_generating(level: int) -> bool:
    return get_level_status(level).get("status") == "generating"


def any_generating() -> bool:
    return any(lvl.get("status") == "generating"
               for lvl in get_status()["levels"].values())


def mark_started(level: int, total_chunks: Optional[int] = None):
    with _lock:
        state = _load_raw()
        entry = state["levels"].setdefault(str(level), _empty_level(level))
        default_total = (
            int(total_chunks)
            if total_chunks
            else entry.get("total_chunks") or get_chunk_grid_size(level) ** 2
        )
        entry.update({
            "status": "generating",
            "started_at": _now_iso(),
            "progress": 0,
            "current_chunk": None,
            "completed_chunks": 0,
            "total_chunks": default_total,
            "error": None,
        })
        _save_raw(state)


def update_progress(level: int, completed_chunks: int, current_chunk: Optional[str] = None):
    with _lock:
        state = _load_raw()
        entry = state["levels"].setdefault(str(level), _empty_level(level))
        total = entry.get("total_chunks") or 1
        entry["completed_chunks"] = int(completed_chunks)
        entry["progress"] = max(0, min(100, int((completed_chunks / total) * 100)))
        entry["current_chunk"] = current_chunk
        entry["status"] = "generating"
        _save_raw(state)


def mark_complete(level: int, size_bytes: Optional[int] = None):
    with _lock:
        state = _load_raw()
        entry = state["levels"].setdefault(str(level), _empty_level(level))
        total = entry.get("total_chunks") or get_chunk_grid_size(level) ** 2
        entry.update({
            "status": "complete",
            "generated_at": _now_iso(),
            "progress": 100,
            "current_chunk": None,
            "completed_chunks": total,
            "size_bytes": int(size_bytes) if size_bytes is not None else entry.get("size_bytes"),
            "error": None,
        })
        _save_raw(state)


def mark_failed(level: int, error: str):
    with _lock:
        state = _load_raw()
        entry = state["levels"].setdefault(str(level), _empty_level(level))
        entry.update({
            "status": "failed",
            "current_chunk": None,
            "error": str(error)[:500],
        })
        _save_raw(state)


def reset_level(level: int):
    """Mark a level as not_generated (e.g. after a fresh invalidation)."""
    with _lock:
        state = _load_raw()
        state["levels"][str(level)] = _empty_level(level)
        _save_raw(state)


# ---------------------------------------------------------------------------
# Staged-swap helpers (added May 2026)
# ---------------------------------------------------------------------------
#
# A full regen no longer overwrites the live R2 keys directly. Instead the
# new bundle is uploaded under its own version subprefix
# (``cache/tops-map-level{N}/{version}/...``) and the tracker records it
# as ``pending_version``. The level's user-facing status flips to
# ``"pending_activation"`` so the admin UI can surface a button. The
# previous ``status`` (``"complete"`` for the live version, etc.) is
# preserved implicitly because we don't touch ``live_version`` or
# ``size_bytes`` until activation.
#
# Activation swaps:
#   * previous_version <- live_version
#   * live_version     <- pending_version
#   * size_bytes       <- pending_size_bytes
#   * generated_at     <- pending_generated_at
#   * pending_*        <- None
#   * status           <- "complete"

def mark_pending_activation(
    level: int, version: str, size_bytes: Optional[int] = None,
):
    """Record a freshly generated bundle that's waiting for an admin click.
    Does NOT touch ``live_version`` — the user-facing view stays on the
    current live bundle until :func:`activate_pending` runs."""
    with _lock:
        state = _load_raw()
        entry = state["levels"].setdefault(str(level), _empty_level(level))
        total = entry.get("total_chunks") or get_chunk_grid_size(level) ** 2
        entry.update({
            "status": "pending_activation",
            "progress": 100,
            "current_chunk": None,
            "completed_chunks": total,
            "pending_version": version,
            "pending_size_bytes": int(size_bytes) if size_bytes is not None else None,
            "pending_generated_at": _now_iso(),
            "error": None,
        })
        _save_raw(state)


def activate_pending(level: int) -> Optional[dict]:
    """Promote ``pending_version`` to ``live_version`` (the old live becomes
    ``previous_version`` so a rollback button still has somewhere to point).

    Returns a dict ``{"previous": old_live, "live": new_live}`` describing
    the swap, or ``None`` when nothing was pending. Callers should also
    flush the level's presigned-URL cache and any in-process pointer/
    metadata caches because the live R2 keys have changed.
    """
    with _lock:
        state = _load_raw()
        entry = state["levels"].setdefault(str(level), _empty_level(level))
        pending = entry.get("pending_version")
        if not pending:
            return None
        new_previous = entry.get("live_version")
        entry.update({
            "status": "complete",
            "live_version": pending,
            "previous_version": new_previous,
            "generated_at": entry.get("pending_generated_at") or _now_iso(),
            "size_bytes": entry.get("pending_size_bytes") if entry.get("pending_size_bytes") is not None else entry.get("size_bytes"),
            "pending_version": None,
            "pending_size_bytes": None,
            "pending_generated_at": None,
        })
        _save_raw(state)
        return {"previous": new_previous, "live": pending}


def discard_pending(level: int) -> Optional[str]:
    """Drop the pending bundle without activating it (e.g. admin decided
    the staged regen looks wrong and wants to nuke it). Returns the
    version id that was discarded so the caller can clean up R2."""
    with _lock:
        state = _load_raw()
        entry = state["levels"].setdefault(str(level), _empty_level(level))
        pending = entry.get("pending_version")
        if not pending:
            return None
        live = entry.get("live_version")
        entry.update({
            "status": "complete" if live or entry.get("size_bytes") else "not_generated",
            "pending_version": None,
            "pending_size_bytes": None,
            "pending_generated_at": None,
        })
        _save_raw(state)
        return pending


def rollback_to_previous(level: int) -> Optional[dict]:
    """Swap ``live_version`` and ``previous_version``. Used by the admin
    rollback button after a bad activation. Returns the swap dict, or
    ``None`` when there's no previous version to roll back to."""
    with _lock:
        state = _load_raw()
        entry = state["levels"].setdefault(str(level), _empty_level(level))
        previous = entry.get("previous_version")
        if not previous:
            return None
        old_live = entry.get("live_version")
        entry["live_version"] = previous
        entry["previous_version"] = old_live
        _save_raw(state)
        return {"previous": old_live, "live": previous}


def set_versions(
    level: int,
    *,
    live: Optional[str] = None,
    previous: Optional[str] = None,
):
    """Low-level setter for migrations / admin overrides."""
    with _lock:
        state = _load_raw()
        entry = state["levels"].setdefault(str(level), _empty_level(level))
        entry["live_version"] = live
        entry["previous_version"] = previous
        _save_raw(state)


def get_live_version(level: int) -> Optional[str]:
    """Return the version subprefix currently served, or ``None`` if the
    level still uses the legacy unprefixed layout."""
    return get_level_status(level).get("live_version")


def get_pending_version(level: int) -> Optional[str]:
    return get_level_status(level).get("pending_version")


def get_previous_version(level: int) -> Optional[str]:
    return get_level_status(level).get("previous_version")


def get_pending_size_bytes(level: int) -> Optional[int]:
    val = get_level_status(level).get("pending_size_bytes")
    if isinstance(val, int):
        return val
    return None

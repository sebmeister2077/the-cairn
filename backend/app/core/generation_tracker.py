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
from .mapdb import RESOLUTION_LEVELS, CHUNK_GRID_SIZE

STATE_KEY = "tops_map_generation_status"

# In-process lock to serialise read-modify-write cycles of the status JSON.
# Generation runs in a single background task per process, so this is enough
# to avoid lost updates from concurrent progress writes.
_lock = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _empty_level() -> dict:
    return {
        "status": "not_generated",
        "generated_at": None,
        "started_at": None,
        "progress": 0,
        "current_chunk": None,
        "total_chunks": CHUNK_GRID_SIZE * CHUNK_GRID_SIZE,
        "completed_chunks": 0,
        "size_bytes": None,
        "error": None,
    }


def _load_raw() -> dict:
    raw = db.get_state(STATE_KEY)
    if not raw:
        return {"levels": {str(lvl): _empty_level() for lvl in RESOLUTION_LEVELS}}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        parsed = {}
    levels = parsed.get("levels") or {}
    # Ensure every configured level has an entry with all required fields.
    for lvl in RESOLUTION_LEVELS:
        key = str(lvl)
        existing = levels.get(key) or {}
        merged = _empty_level()
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
    return get_status()["levels"].get(str(level), _empty_level())


def is_generating(level: int) -> bool:
    return get_level_status(level).get("status") == "generating"


def any_generating() -> bool:
    return any(lvl.get("status") == "generating"
               for lvl in get_status()["levels"].values())


def mark_started(level: int, total_chunks: Optional[int] = None):
    with _lock:
        state = _load_raw()
        entry = state["levels"].setdefault(str(level), _empty_level())
        entry.update({
            "status": "generating",
            "started_at": _now_iso(),
            "progress": 0,
            "current_chunk": None,
            "completed_chunks": 0,
            "total_chunks": int(total_chunks) if total_chunks else entry.get("total_chunks") or CHUNK_GRID_SIZE * CHUNK_GRID_SIZE,
            "error": None,
        })
        _save_raw(state)


def update_progress(level: int, completed_chunks: int, current_chunk: Optional[str] = None):
    with _lock:
        state = _load_raw()
        entry = state["levels"].setdefault(str(level), _empty_level())
        total = entry.get("total_chunks") or 1
        entry["completed_chunks"] = int(completed_chunks)
        entry["progress"] = max(0, min(100, int((completed_chunks / total) * 100)))
        entry["current_chunk"] = current_chunk
        entry["status"] = "generating"
        _save_raw(state)


def mark_complete(level: int, size_bytes: Optional[int] = None):
    with _lock:
        state = _load_raw()
        entry = state["levels"].setdefault(str(level), _empty_level())
        total = entry.get("total_chunks") or CHUNK_GRID_SIZE * CHUNK_GRID_SIZE
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
        entry = state["levels"].setdefault(str(level), _empty_level())
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
        state["levels"][str(level)] = _empty_level()
        _save_raw(state)

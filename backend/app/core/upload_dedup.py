"""Tier 5 (May 2026) — content-hash skip cache for R2 chunk uploads.

The TOPS map regen worker re-PNG-encodes and re-uploads every chunk for
every level on every full regen. Once Tier 3.2 removed the per-tile varint
decode as the bottleneck, the new floor became R2 PUT latency × number of
chunks (thousands per pass). A user-initiated full regen of an unchanged
combined.db therefore takes ~24 minutes despite producing byte-identical
PNGs on R2.

This module persists a small SQLite sidecar keyed to the canonical
combined.db path (``<canonical>.upload.db``) that remembers the
``sha256(png_bytes)`` we last uploaded for each ``(level, cx, cz)``. The
regen hot path looks up the hash before issuing the R2 PUT and skips the
network round-trip entirely when the new PNG hashes to the same value.

Properties:

* **Correct across combined.db rotations** — the dedup table tracks "what
  we last PUT to R2 at key X", independent of the source DB. A merge that
  changes one tile produces a different PNG hash for chunks intersecting
  that tile, which naturally triggers a re-upload. Chunks whose content is
  unchanged are skipped. No explicit invalidation needed.
* **Single-process** — one shared sqlite conn guarded by a lock. Lookups
  are primary-key fetches in WAL mode and take microseconds; they won't
  serialize the upload threadpool meaningfully.
* **Safe to wipe** — deleting ``<canonical>.upload.db`` forces a full
  re-upload of all chunks on the next regen, which is exactly the recovery
  procedure if R2 ever gets cleared externally.

Kill switch
-----------
Set ``MAPDB_DISABLE_UPLOAD_DEDUP=1`` in the worker env to bypass the cache
entirely (every PUT runs, dedup writes/reads are no-ops). Useful for
forcing a verification pass after an external R2 mutation.
"""

from __future__ import annotations

import hashlib
import logging
import os
import sqlite3
import threading
from typing import Optional

logger = logging.getLogger("uvicorn.error")

DEDUP_SUFFIX = ".upload.db"
_TABLE = "chunk_hashes"
_LEVEL_TABLE = "level_state"


def _disabled() -> bool:
    raw = os.environ.get("MAPDB_DISABLE_UPLOAD_DEDUP")
    if raw is None:
        return False
    return raw.strip().lower() in ("1", "true", "yes", "on")


def dedup_path_for(canonical_src: str) -> str:
    """Return the dedup sidecar path for a canonical combined.db path.

    Keep this keyed to the *canonical* path (the shared cached
    combined.db), not any per-pass snapshot, so the table survives across
    regen passes."""
    return canonical_src + DEDUP_SUFFIX


def open_dedup(canonical_src: Optional[str]) -> Optional[sqlite3.Connection]:
    """Open (or create) the dedup sidecar. Returns None when the feature
    is disabled or no canonical path is available.

    The returned connection has ``check_same_thread=False`` so the
    upload threadpool can share it under a single guarding lock.
    """
    if _disabled() or not canonical_src:
        return None
    path = dedup_path_for(canonical_src)
    try:
        conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        # WAL + small mmap: tiny table, the goal is just to remove fsync
        # latency from the upload hot path. NORMAL sync is safe here —
        # if we lose the last few writes after a crash the worst case is
        # a few extra R2 uploads on the next pass.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA temp_store=MEMORY")
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS {_TABLE} ("
            "level INTEGER NOT NULL,"
            "cx INTEGER NOT NULL,"
            "cz INTEGER NOT NULL,"
            "sha256 BLOB,"
            "PRIMARY KEY(level, cx, cz)"
            ") WITHOUT ROWID"
        )
        # Tier 6 (May 2026) — whole-level skip cache. When the canonical
        # combined.db mtime matches the value recorded at the last
        # successful full-level regen, the entire level can be skipped:
        # no snapshot scan, no render, no encode, no PUT. The cached
        # ``size_bytes`` is reused so the metadata totals stay
        # consistent. Mtime is set by ``os.replace()`` in the approval
        # merge flow so any change to combined.db invalidates this row
        # naturally.
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS {_LEVEL_TABLE} ("
            "level INTEGER PRIMARY KEY,"
            "source_mtime REAL NOT NULL,"
            "size_bytes INTEGER NOT NULL,"
            "completed_at TEXT"
            ")"
        )
        return conn
    except sqlite3.DatabaseError:
        logger.exception(
            "upload_dedup: could not open dedup sidecar at %s — "
            "deleting and retrying once",
            path,
        )
        try:
            os.unlink(path)
        except OSError:
            return None
        try:
            conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(
                f"CREATE TABLE IF NOT EXISTS {_TABLE} ("
                "level INTEGER NOT NULL, cx INTEGER NOT NULL, cz INTEGER NOT NULL,"
                "sha256 BLOB, PRIMARY KEY(level, cx, cz)) WITHOUT ROWID"
            )
            conn.execute(
                f"CREATE TABLE IF NOT EXISTS {_LEVEL_TABLE} ("
                "level INTEGER PRIMARY KEY, source_mtime REAL NOT NULL,"
                "size_bytes INTEGER NOT NULL, completed_at TEXT)"
            )
            return conn
        except sqlite3.DatabaseError:
            return None


def hash_png(png_bytes: Optional[bytes]) -> Optional[bytes]:
    """Compute the dedup hash for a PNG payload. None for empty chunks."""
    if png_bytes is None:
        return None
    return hashlib.sha256(png_bytes).digest()


# A sentinel object distinct from None so callers can tell "no row stored"
# (need to upload) apart from "row stored, marker says empty/deleted".
_MISSING = object()


def lookup_hash(
    conn: Optional[sqlite3.Connection],
    lock: threading.Lock,
    level: int,
    cx: int,
    cz: int,
):
    """Return the stored hash (bytes), None (stored-as-empty marker), or
    the module-level ``_MISSING`` sentinel when no row exists."""
    if conn is None:
        return _MISSING
    with lock:
        row = conn.execute(
            f"SELECT sha256 FROM {_TABLE} WHERE level=? AND cx=? AND cz=?",
            (level, cx, cz),
        ).fetchone()
    if row is None:
        return _MISSING
    return row[0]  # may be None for "known empty"


def should_skip_upload(
    conn: Optional[sqlite3.Connection],
    lock: threading.Lock,
    level: int,
    cx: int,
    cz: int,
    new_hash: Optional[bytes],
) -> bool:
    """Return True when (level, cx, cz) is known to already be at
    ``new_hash`` on R2 — in which case the caller may skip the PUT/DELETE.

    ``new_hash=None`` represents "this chunk is empty" (the regen path
    sends a DELETE). If the stored marker is also None, the chunk is
    known-deleted and the DELETE can be skipped too.
    """
    if conn is None:
        return False
    stored = lookup_hash(conn, lock, level, cx, cz)
    if stored is _MISSING:
        return False
    return stored == new_hash


def record(
    conn: Optional[sqlite3.Connection],
    lock: threading.Lock,
    level: int,
    cx: int,
    cz: int,
    new_hash: Optional[bytes],
) -> None:
    """Persist the freshly-uploaded hash (or None for empty/deleted)."""
    if conn is None:
        return
    with lock:
        conn.execute(
            f"INSERT INTO {_TABLE} (level, cx, cz, sha256) VALUES (?, ?, ?, ?) "
            f"ON CONFLICT(level, cx, cz) DO UPDATE SET sha256=excluded.sha256",
            (level, cx, cz, new_hash),
        )


def close(conn: Optional[sqlite3.Connection]) -> None:
    if conn is None:
        return
    try:
        conn.close()
    except sqlite3.Error:
        pass


def row_count(conn: Optional[sqlite3.Connection]) -> int:
    if conn is None:
        return 0
    try:
        return int(conn.execute(f"SELECT COUNT(*) FROM {_TABLE}").fetchone()[0])
    except sqlite3.DatabaseError:
        return 0


# ---------------------------------------------------------------------------
# Tier 6 — whole-level skip
# ---------------------------------------------------------------------------

import time as _time

_MTIME_EPSILON = 1e-3  # tolerate FS mtime float rounding (1 ms)


def can_skip_level(
    conn: Optional[sqlite3.Connection],
    lock: threading.Lock,
    level: int,
    source_mtime: Optional[float],
) -> Optional[int]:
    """Return the cached ``size_bytes`` when the level can be skipped
    wholesale, else None.

    Skip iff a previous full regen recorded a ``(level, source_mtime)``
    pair that matches the current canonical combined.db mtime (within
    1 ms to tolerate FS float rounding). Any merge that touched the
    canonical DB bumps mtime via ``os.replace()`` and invalidates this.
    """
    if conn is None or source_mtime is None:
        return None
    with lock:
        row = conn.execute(
            f"SELECT source_mtime, size_bytes FROM {_LEVEL_TABLE} WHERE level=?",
            (level,),
        ).fetchone()
    if row is None:
        return None
    stored_mtime, size_bytes = row
    if stored_mtime is None:
        return None
    if abs(float(stored_mtime) - float(source_mtime)) > _MTIME_EPSILON:
        return None
    return int(size_bytes)


def record_level_complete(
    conn: Optional[sqlite3.Connection],
    lock: threading.Lock,
    level: int,
    source_mtime: Optional[float],
    size_bytes: int,
) -> None:
    """Persist the fact that ``level`` was just regenerated end-to-end
    against a combined.db whose mtime was ``source_mtime``. Stored in the
    same dedup sidecar so a single file holds all skip state."""
    if conn is None or source_mtime is None:
        return
    now_iso = _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())
    with lock:
        conn.execute(
            f"INSERT INTO {_LEVEL_TABLE} (level, source_mtime, size_bytes, completed_at) "
            f"VALUES (?, ?, ?, ?) "
            f"ON CONFLICT(level) DO UPDATE SET "
            f"  source_mtime=excluded.source_mtime, "
            f"  size_bytes=excluded.size_bytes, "
            f"  completed_at=excluded.completed_at",
            (level, float(source_mtime), int(size_bytes), now_iso),
        )


def invalidate_level(
    conn: Optional[sqlite3.Connection],
    lock: threading.Lock,
    level: int,
) -> None:
    """Drop the whole-level skip marker for ``level``. Use when geometry
    changes or when callers want to force a full re-render on the next pass.
    """
    if conn is None:
        return
    with lock:
        conn.execute(f"DELETE FROM {_LEVEL_TABLE} WHERE level=?", (level,))


def level_state_rows(conn: Optional[sqlite3.Connection]) -> list:
    """Debug helper — dump the level_state table."""
    if conn is None:
        return []
    try:
        return list(conn.execute(
            f"SELECT level, source_mtime, size_bytes, completed_at "
            f"FROM {_LEVEL_TABLE} ORDER BY level"
        ))
    except sqlite3.DatabaseError:
        return []

"""Supabase PostgreSQL client for structured data.

Tables:
  - contributions     — one row per contribution (pending, approved, rejected)
  - contribution_log  — approved merge history
  - app_state         — key/value for things like cached tile count
"""

from contextlib import contextmanager
from datetime import datetime, timezone
import json
from typing import List, Optional

import psycopg2
import psycopg2.extras
from psycopg2 import pool as pg_pool

from ..config import settings

_pool = None


def init_db():
    """Create a simple connection pool. Call once at startup."""
    global _pool
    if not settings.SUPABASE_DB_URL:
        raise RuntimeError("SUPABASE_DB_URL is not configured")
    _pool = pg_pool.SimpleConnectionPool(
        minconn=1,
        maxconn=5,
        dsn=settings.SUPABASE_DB_URL,
    )


def close_db():
    """Close the connection pool. Call at shutdown."""
    global _pool
    if _pool:
        _pool.closeall()
        _pool = None


@contextmanager
def get_conn():
    """Yield a connection from the pool; auto-returns on exit."""
    conn = _pool.getconn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _pool.putconn(conn)


# ---------------------------------------------------------------------------
# Schema bootstrap (idempotent)
# ---------------------------------------------------------------------------

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS contributions (
    id              TEXT PRIMARY KEY,
    contributor     TEXT NOT NULL DEFAULT 'Anonymous',
    tile_count      INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at     TIMESTAMPTZ,
    tiles_new       INTEGER,
    tiles_existing  INTEGER,
    combined_total  INTEGER
);

CREATE TABLE IF NOT EXISTS contribution_log (
    id              TEXT PRIMARY KEY,
    contributor     TEXT NOT NULL,
    approved_at     TIMESTAMPTZ NOT NULL,
    tiles_new       INTEGER NOT NULL DEFAULT 0,
    tiles_existing  INTEGER NOT NULL DEFAULT 0,
    combined_total  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
    key             TEXT PRIMARY KEY,
    name            TEXT NOT NULL DEFAULT '',
    permissions     TEXT NOT NULL DEFAULT 'read',
    consume_once    BOOLEAN NOT NULL DEFAULT FALSE,
    bound_identity  TEXT,
    revoked         BOOLEAN NOT NULL DEFAULT FALSE,
    usage_count     BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ
);
"""

_MIGRATIONS_SQL = """
ALTER TABLE api_keys
ADD COLUMN IF NOT EXISTS usage_count BIGINT NOT NULL DEFAULT 0;
"""


def ensure_schema():
    """Create tables if they don't exist. Safe to call multiple times."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(_SCHEMA_SQL)
            # Backfill schema changes for existing deployments.
            cur.execute(_MIGRATIONS_SQL)


# ---------------------------------------------------------------------------
# Contributions CRUD
# ---------------------------------------------------------------------------

def create_contribution(cid: str, contributor: str, tile_count: int):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO contributions (id, contributor, tile_count, status)
                   VALUES (%s, %s, %s, 'pending')""",
                (cid, contributor or "Anonymous", tile_count),
            )


def get_contribution(cid: str) -> Optional[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM contributions WHERE id = %s", (cid,))
            row = cur.fetchone()
            return dict(row) if row else None


def list_pending_contributions() -> List[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM contributions WHERE status = 'pending' ORDER BY created_at"
            )
            return [dict(r) for r in cur.fetchall()]


def mark_approved(cid: str, tiles_new: int, tiles_existing: int, combined_total: int):
    now = datetime.now(timezone.utc)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE contributions
                   SET status = 'approved', approved_at = %s,
                       tiles_new = %s, tiles_existing = %s, combined_total = %s
                   WHERE id = %s""",
                (now, tiles_new, tiles_existing, combined_total, cid),
            )
            cur.execute(
                """INSERT INTO contribution_log
                       (id, contributor, approved_at, tiles_new, tiles_existing, combined_total)
                   SELECT id, contributor, %s, %s, %s, %s
                   FROM contributions WHERE id = %s""",
                (now, tiles_new, tiles_existing, combined_total, cid),
            )


def delete_contribution(cid: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM contributions WHERE id = %s", (cid,))


def get_approved_log(limit: int = 20) -> List[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM contribution_log ORDER BY approved_at DESC LIMIT %s",
                (limit,),
            )
            return [dict(r) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# App-level key/value state
# ---------------------------------------------------------------------------

TILE_COUNT_KEY = "tile_count"
TOPS_MAP_STATS_KEY = "tops_map_stats"


def get_state(key: str) -> Optional[str]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT value FROM app_state WHERE key = %s", (key,))
            row = cur.fetchone()
            return row[0] if row else None


def set_state(key: str, value: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO app_state (key, value) VALUES (%s, %s)
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value""",
                (key, value),
            )


def get_cached_tile_count() -> int:
    val = get_state(TILE_COUNT_KEY)
    return int(val) if val else 0


def set_cached_tile_count(count: int):
    set_state(TILE_COUNT_KEY, str(count))


def get_tops_map_stats() -> Optional[dict]:
    """Get cached TOPS map stats JSON from app_state."""
    val = get_state(TOPS_MAP_STATS_KEY)
    if not val:
        return None
    try:
        parsed = json.loads(val)
        return parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, TypeError):
        return None


# ---------------------------------------------------------------------------
# DB availability check
# ---------------------------------------------------------------------------

def is_available() -> bool:
    """Return True if the connection pool has been initialised."""
    return _pool is not None


# ---------------------------------------------------------------------------
# API Keys CRUD
# ---------------------------------------------------------------------------

def create_api_key(key: str, name: str, permissions: str, consume_once: bool) -> dict:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO api_keys (key, name, permissions, consume_once)
                   VALUES (%s, %s, %s, %s)
                   RETURNING *""",
                (key, name, permissions, consume_once),
            )
            row = cur.fetchone()
            return dict(row)


def list_api_keys() -> List[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM api_keys ORDER BY created_at DESC")
            rows = cur.fetchall()
            return [dict(r) for r in rows]


def get_api_key(key: str) -> Optional[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM api_keys WHERE key = %s", (key,))
            row = cur.fetchone()
            return dict(row) if row else None


def bind_api_key(key: str, identity: str):
    """Bind a consume-once key to the first user's identity (only if not yet bound)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE api_keys SET bound_identity = %s WHERE key = %s AND bound_identity IS NULL",
                (identity, key),
            )


def touch_api_key(key: str):
    """Update last_used_at timestamp and increment usage counter."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE api_keys SET last_used_at = now(), usage_count = usage_count + 1 WHERE key = %s",
                (key,),
            )


def revoke_api_key(key: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE api_keys SET revoked = TRUE WHERE key = %s", (key,))


def set_tops_map_stats(stats: dict):
    """Persist TOPS map stats JSON in app_state."""
    set_state(TOPS_MAP_STATS_KEY, json.dumps(stats))

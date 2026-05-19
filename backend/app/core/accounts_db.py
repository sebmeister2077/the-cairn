"""Account-system database helpers.

Functions for the `users`, `ip_bans`, `user_flags`, and `admin_audit_log`
tables. The schema is created in `database.ensure_schema()`; this module
only contains CRUD helpers.
"""

from datetime import datetime, timezone
import json
from typing import List, Optional
from uuid import UUID

import psycopg2.extras

from .database import get_conn, get_state, set_state
from . import api_key_cache


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def normalise_ingame_name(name: Optional[str]) -> Optional[str]:
    """Normalise an in-game name for duplicate detection.

    Strips whitespace, casefolds, collapses internal whitespace.
    Returns None for null / empty input.
    """
    if not name:
        return None
    parts = name.strip().split()
    if not parts:
        return None
    return " ".join(parts).casefold()


# ---------------------------------------------------------------------------
# users CRUD
# ---------------------------------------------------------------------------

def create_user(
    api_key: str,
    display_name: str,
    terms_version: str,
    genesis_for_ip: bool = False,
) -> dict:
    """Create a users row. Caller must ensure display_name is unique.

    ``api_key`` is the auth-token string; we resolve it to the
    ``api_keys.id`` UUID before insert (the schema only stores the FK
    now).
    """
    key_id = api_key_cache.ensure_id(api_key)
    if key_id is None:
        raise ValueError("create_user: api_key not found in api_keys table")
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO users (api_key_id, display_name, terms_version, genesis_for_ip)
                       VALUES (%s, %s, %s, %s)
                       RETURNING *""",
                (str(key_id), display_name, terms_version, genesis_for_ip),
            )
            return dict(cur.fetchone())


def get_user(api_key: str) -> Optional[dict]:
    """Look up a users row by the caller's api_key string.

    Translates the key to its ``api_keys.id`` UUID via the cache and
    queries on ``users.api_key_id``.
    """
    key_id = api_key_cache.ensure_id(api_key)
    if key_id is None:
        return None
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM users WHERE api_key_id = %s", (str(key_id),))
            row = cur.fetchone()
            return dict(row) if row else None


def display_name_taken(name: str) -> bool:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM users WHERE display_name = %s", (name,))
            return cur.fetchone() is not None


def update_user_profile(
    api_key: str,
    in_game_name: Optional[str] = None,
    is_hireable: Optional[bool] = None,
    is_leaderboard_visible: Optional[bool] = None,
    show_contributions: Optional[bool] = None,
    clear_in_game_name: bool = False,
    use_in_game_name: Optional[bool] = None,
    display_name: Optional[str] = None,
) -> Optional[dict]:
    """Update mutable profile fields. Returns the updated row, or None if missing.

    ``display_name`` is normally not settable directly by the user, but the
    account route passes it explicitly when toggling ``use_in_game_name``: it
    mirrors the in-game name when the toggle goes ON, and is replaced with a
    freshly generated random name when the toggle goes OFF. When ``display_name``
    changes, ``last_name_change_at`` is bumped.
    """
    sets: List[str] = []
    params: List = []
    if clear_in_game_name:
        sets.append("in_game_name = NULL")
    elif in_game_name is not None:
        sets.append("in_game_name = %s")
        params.append(in_game_name)
    if is_hireable is not None:
        sets.append("is_hireable = %s")
        params.append(is_hireable)
    if is_leaderboard_visible is not None:
        sets.append("is_leaderboard_visible = %s")
        params.append(is_leaderboard_visible)
    if show_contributions is not None:
        sets.append("show_contributions = %s")
        params.append(show_contributions)
    if use_in_game_name is not None:
        sets.append("use_in_game_name = %s")
        params.append(use_in_game_name)
    if display_name is not None:
        sets.append("display_name = %s")
        params.append(display_name)
        sets.append("last_name_change_at = now()")
    if not sets:
        return get_user(api_key)
    key_id = api_key_cache.ensure_id(api_key)
    if key_id is None:
        return None
    params.append(str(key_id))
    sql = f"UPDATE users SET {', '.join(sets)} WHERE api_key_id = %s RETURNING *"
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
            return dict(row) if row else None


def regenerate_user_display_name(api_key: str, new_name: str) -> Optional[dict]:
    key_id = api_key_cache.ensure_id(api_key)
    if key_id is None:
        return None
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """UPDATE users
                       SET display_name = %s,
                           name_regen_count = name_regen_count + 1,
                           last_name_change_at = now()
                       WHERE api_key_id = %s
                       RETURNING *""",
                (new_name, str(key_id)),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def soft_delete_user(api_key: str, tombstone_name: str) -> Optional[dict]:
    """Mark the user deleted, replace display_name with tombstone, clear personal fields,
    and revoke their API key. Returns the updated row, or None if not found."""
    now = datetime.now(timezone.utc)
    key_id = api_key_cache.ensure_id(api_key)
    if key_id is None:
        return None
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """UPDATE users
                       SET deleted_at = %s,
                           display_name = %s,
                           in_game_name = NULL,
                           use_in_game_name = FALSE,
                           is_hireable = FALSE,
                           is_leaderboard_visible = FALSE
                       WHERE api_key_id = %s AND deleted_at IS NULL
                       RETURNING *""",
                (now, tombstone_name, str(key_id)),
            )
            row = cur.fetchone()
            if not row:
                return None
            cur.execute("UPDATE api_keys SET revoked = TRUE WHERE id = %s", (str(key_id),))
            api_key_cache.invalidate(api_key)
            return dict(row)


def reactivate_user(api_key: str) -> Optional[dict]:
    """Admin-only: clear deleted_at and un-revoke the key."""
    key_id = api_key_cache.ensure_id(api_key)
    if key_id is None:
        return None
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """UPDATE users
                       SET deleted_at = NULL
                       WHERE api_key_id = %s
                       RETURNING *""",
                (str(key_id),),
            )
            row = cur.fetchone()
            if not row:
                return None
            cur.execute("UPDATE api_keys SET revoked = FALSE WHERE id = %s", (str(key_id),))
            api_key_cache.invalidate(api_key)
            return dict(row)


def rekey_user(old_key: str, new_key: str) -> Optional[dict]:
    """Move a users row from ``old_key`` to ``new_key`` and revoke the old.

    Both api_keys rows must already exist. Returns the updated users row,
    or None if ``old_key`` was not found.
    """
    old_id = api_key_cache.ensure_id(old_key)
    new_id = api_key_cache.ensure_id(new_key)
    if old_id is None or new_id is None:
        return None
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "UPDATE users SET api_key_id = %s WHERE api_key_id = %s RETURNING *",
                (str(new_id), str(old_id)),
            )
            row = cur.fetchone()
            if not row:
                return None
            cur.execute("UPDATE api_keys SET revoked = TRUE WHERE id = %s", (str(old_id),))
            api_key_cache.invalidate(old_key)
            return dict(row)


def find_active_users_by_ingame_name(
    normalised: str,
    exclude_key: str = "",
) -> List[dict]:
    """Return non-deleted users whose normalised in_game_name matches."""
    exclude_id = api_key_cache.ensure_id(exclude_key) if exclude_key else None
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT * FROM users
                       WHERE deleted_at IS NULL
                         AND in_game_name IS NOT NULL
                         AND lower(regexp_replace(trim(in_game_name), '\\s+', ' ', 'g')) = %s
                         AND (%s::uuid IS NULL OR api_key_id <> %s::uuid)""",
                (normalised, str(exclude_id) if exclude_id else None,
                 str(exclude_id) if exclude_id else None),
            )
            return [dict(r) for r in cur.fetchall()]


def list_users(
    query: str = "",
    sort_by: str = "joined_at",
    cursor: Optional[int] = None,
    limit: int = 20,
    filter_flagged: bool = False,
    filter_banned: bool = False,
    filter_genesis: bool = False,
    include_deleted: bool = True,
    exclude_admin: bool = True,
) -> dict:
    """Paginated user list using OFFSET pagination (sufficient for current scale).

    Returns ``{ "users": [...], "next_cursor": Optional[int] }``.
    Each row is enriched with last_used_at / bound_identity from api_keys
    plus a flag count.
    """
    sort_sql = {
        "joined_at": "u.joined_at DESC",
        "last_login_at": "ak.last_used_at DESC NULLS LAST",
        "is_hireable": "u.is_hireable DESC, u.joined_at DESC",
    }.get(sort_by, "u.joined_at DESC")

    where: List[str] = []
    params: List = []
    if query:
        where.append("(u.display_name ILIKE %s OR u.in_game_name ILIKE %s)")
        like = f"%{query}%"
        params.extend([like, like])
    if filter_genesis:
        where.append("u.genesis_for_ip = TRUE")
    if filter_banned:
        where.append("EXISTS (SELECT 1 FROM ip_bans b WHERE b.ip_hash = ak.bound_identity)")
    if filter_flagged:
        where.append(
            "EXISTS (SELECT 1 FROM user_flags f "
            "WHERE f.flagged_user_id = u.id AND f.resolved_at IS NULL)"
        )
    if not include_deleted:
        where.append("u.deleted_at IS NULL")
    if exclude_admin:
        where.append("u.display_name <> '__admin__'")

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    offset = int(cursor or 0)

    sql = f"""
        SELECT u.*,
               ak.key AS api_key,
               ak.last_used_at,
               ak.bound_identity,
               ak.revoked AS key_revoked,
               (SELECT COUNT(*) FROM user_flags f
                  WHERE f.flagged_user_id = u.id AND f.resolved_at IS NULL) AS flag_count,
               EXISTS (SELECT 1 FROM ip_bans b
                  WHERE b.ip_hash = ak.bound_identity) AS is_banned
          FROM users u
          LEFT JOIN api_keys ak ON ak.id = u.api_key_id
        {where_sql}
        ORDER BY {sort_sql}
        LIMIT %s OFFSET %s
    """
    params_q = list(params) + [limit + 1, offset]
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params_q)
            rows = [dict(r) for r in cur.fetchall()]
    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        next_cursor = offset + limit
    return {"users": rows, "next_cursor": next_cursor}


def get_user_with_key(api_key: str) -> Optional[dict]:
    """User row enriched with api_keys metadata and live counters."""
    key_id = api_key_cache.ensure_id(api_key)
    if key_id is None:
        return None
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT u.*,
                          ak.key AS api_key,
                          ak.last_used_at,
                          ak.bound_identity,
                          ak.revoked AS key_revoked,
                          ak.usage_count,
                          (SELECT COUNT(*) FROM user_flags f
                              WHERE f.flagged_user_id = u.id AND f.resolved_at IS NULL) AS flag_count,
                          EXISTS (SELECT 1 FROM ip_bans b
                              WHERE b.ip_hash = ak.bound_identity) AS is_banned
                   FROM users u
                   LEFT JOIN api_keys ak ON ak.id = u.api_key_id
                   WHERE u.api_key_id = %s""",
                (str(key_id),),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def get_user_stats() -> dict:
    """Return aggregate counts for the admin banner."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT
                    COUNT(*) FILTER (WHERE display_name <> '__admin__') AS total,
                    COUNT(*) FILTER (WHERE deleted_at IS NULL AND display_name <> '__admin__') AS active,
                    COUNT(*) FILTER (WHERE is_hireable AND deleted_at IS NULL) AS hireable,
                    COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted
                  FROM users"""
            )
            total, active, hireable, deleted = cur.fetchone()
            cur.execute(
                """SELECT COUNT(*) FROM users u
                       JOIN api_keys ak ON ak.id = u.api_key_id
                       WHERE u.deleted_at IS NULL
                         AND u.display_name <> '__admin__'
                         AND ak.last_used_at > now() - interval '7 days'"""
            )
            (active_7d,) = cur.fetchone()
            cur.execute("SELECT COUNT(*) FROM ip_bans WHERE expires_at > now()")
            (banned,) = cur.fetchone()
            cur.execute(
                """SELECT COUNT(DISTINCT flagged_user_id) FROM user_flags
                       WHERE resolved_at IS NULL"""
            )
            (flagged,) = cur.fetchone()
    return {
        "total": int(total or 0),
        "active": int(active or 0),
        "hireable": int(hireable or 0),
        "deleted": int(deleted or 0),
        "banned": int(banned or 0),
        "active_last_7_days": int(active_7d or 0),
        "flagged": int(flagged or 0),
    }


def get_sibling_users(api_key: str) -> List[dict]:
    """Return all users whose api_key is bound to the same IP hash as ``api_key``.

    Excludes the user themselves. Used by admins to investigate alt accounts.
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT u.*, ak.key AS api_key, ak.last_used_at,
                          ak.bound_identity, ak.revoked AS key_revoked
                   FROM users u
                   JOIN api_keys ak ON ak.id = u.api_key_id
                   WHERE ak.bound_identity = (
                       SELECT bound_identity FROM api_keys WHERE key = %s
                   )
                   AND ak.bound_identity IS NOT NULL
                   AND ak.key <> %s
                   ORDER BY u.joined_at""",
                (api_key, api_key),
            )
            return [dict(r) for r in cur.fetchall()]


def list_users_for_ip_hash(ip_hash: str) -> List[dict]:
    """Return all users (including deleted) whose key is bound to ip_hash."""
    if not ip_hash:
        return []
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT u.*, ak.key AS api_key, ak.bound_identity
                   FROM users u
                   JOIN api_keys ak ON ak.id = u.api_key_id
                   WHERE ak.bound_identity = %s""",
                (ip_hash,),
            )
            return [dict(r) for r in cur.fetchall()]


def revoke_keys_for_ip_hash(ip_hash: str) -> int:
    """Revoke every api_key bound to ip_hash. Returns # rows updated."""
    if not ip_hash:
        return 0
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE api_keys SET revoked = TRUE WHERE bound_identity = %s",
                (ip_hash,),
            )
            return cur.rowcount or 0


def first_account_on_ip(ip_hash: str) -> Optional[dict]:
    """Return the earliest non-deleted user on the given IP hash, or None."""
    if not ip_hash:
        return None
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT u.*, ak.key AS api_key
                   FROM users u
                   JOIN api_keys ak ON ak.id = u.api_key_id
                   WHERE ak.bound_identity = %s
                     AND u.deleted_at IS NULL
                   ORDER BY u.joined_at ASC
                   LIMIT 1""",
                (ip_hash,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


# ---------------------------------------------------------------------------
# ip_bans
# ---------------------------------------------------------------------------

def is_ip_banned(ip_hash: str) -> bool:
    if not ip_hash:
        return False
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM ip_bans WHERE ip_hash = %s AND expires_at > now()",
                (ip_hash,),
            )
            return cur.fetchone() is not None


def get_ip_ban(ip_hash: str) -> Optional[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM ip_bans WHERE ip_hash = %s", (ip_hash,))
            row = cur.fetchone()
            return dict(row) if row else None


def create_ip_ban(
    ip_hash: str,
    reason_code: str,
    reason: str,
    admin_notes: Optional[str],
    banned_by: str,
    expires_at: datetime,
) -> dict:
    """Create or refresh an IP ban. ``banned_by`` is the admin's api_key
    string; we resolve it to the FK ``banned_by_key_id`` UUID."""
    banned_by_id = api_key_cache.ensure_id(banned_by)
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO ip_bans
                       (ip_hash, reason_code, reason, admin_notes, banned_by_key_id, expires_at)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   ON CONFLICT (ip_hash) DO UPDATE
                     SET reason_code      = EXCLUDED.reason_code,
                         reason           = EXCLUDED.reason,
                         admin_notes      = EXCLUDED.admin_notes,
                         banned_by_key_id = EXCLUDED.banned_by_key_id,
                         banned_at        = now(),
                         expires_at       = EXCLUDED.expires_at
                   RETURNING *""",
                (ip_hash, reason_code, reason, admin_notes,
                 str(banned_by_id) if banned_by_id else None, expires_at),
            )
            return dict(cur.fetchone())


def delete_ip_ban(ip_hash: str) -> bool:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM ip_bans WHERE ip_hash = %s", (ip_hash,))
            return cur.rowcount > 0


def list_ip_bans(cursor: Optional[int] = None, limit: int = 50) -> dict:
    offset = int(cursor or 0)
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT * FROM ip_bans
                       WHERE expires_at > now()
                       ORDER BY banned_at DESC
                       LIMIT %s OFFSET %s""",
                (limit + 1, offset),
            )
            rows = [dict(r) for r in cur.fetchall()]
    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        next_cursor = offset + limit
    return {"bans": rows, "next_cursor": next_cursor}


def cleanup_expired_ip_bans() -> int:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM ip_bans WHERE expires_at <= now()")
            return cur.rowcount or 0


# ---------------------------------------------------------------------------
# user_flags
# ---------------------------------------------------------------------------

def create_user_flag(
    flagged_user: str,
    reason: str,
    related_user: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> dict:
    """Insert a user_flag. ``flagged_user`` / ``related_user`` are api_key
    strings; the schema stores ``users.id`` UUIDs in the new
    ``flagged_user_id`` / ``related_user_id`` columns, so we resolve
    api_key → api_keys.id → users.id (via subquery in a single SELECT)."""
    flagged_key_id = api_key_cache.ensure_id(flagged_user)
    if flagged_key_id is None:
        raise ValueError("create_user_flag: flagged_user api_key not found")
    related_key_id = api_key_cache.ensure_id(related_user) if related_user else None
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO user_flags (flagged_user_id, related_user_id, reason, metadata)
                       VALUES (
                           (SELECT id FROM users WHERE api_key_id = %s),
                           (SELECT id FROM users WHERE api_key_id = %s),
                           %s,
                           %s
                       )
                       RETURNING *""",
                (str(flagged_key_id),
                 str(related_key_id) if related_key_id else None,
                 reason,
                 json.dumps(metadata) if metadata else None),
            )
            return dict(cur.fetchone())


def list_user_flags(
    unresolved_only: bool = False,
    reason: Optional[str] = None,
    flagged_user: Optional[str] = None,
    cursor: Optional[int] = None,
    limit: int = 50,
) -> dict:
    where: List[str] = []
    params: List = []
    if unresolved_only:
        where.append("f.resolved_at IS NULL")
    if reason:
        where.append("f.reason = %s")
        params.append(reason)
    if flagged_user:
        # flagged_user param is an api_key string; resolve to users.id via
        # the api_keys/users join in a subquery.
        flagged_key_id = api_key_cache.ensure_id(flagged_user)
        if flagged_key_id is None:
            return {"flags": [], "next_cursor": None}
        where.append("f.flagged_user_id = (SELECT id FROM users WHERE api_key_id = %s)")
        params.append(str(flagged_key_id))
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    offset = int(cursor or 0)
    sql = f"""
        SELECT f.*,
               flagged.display_name AS flagged_display_name,
               flagged_ak.key       AS flagged_user,
               related.display_name AS related_display_name,
               related_ak.key       AS related_user
          FROM user_flags f
          LEFT JOIN users     flagged    ON flagged.id    = f.flagged_user_id
          LEFT JOIN api_keys  flagged_ak ON flagged_ak.id = flagged.api_key_id
          LEFT JOIN users     related    ON related.id    = f.related_user_id
          LEFT JOIN api_keys  related_ak ON related_ak.id = related.api_key_id
        {where_sql}
        ORDER BY f.created_at DESC
        LIMIT %s OFFSET %s
    """
    params_q = list(params) + [limit + 1, offset]
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params_q)
            rows = [dict(r) for r in cur.fetchall()]
    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        next_cursor = offset + limit
    return {"flags": rows, "next_cursor": next_cursor}


def resolve_user_flag(flag_id: int, admin_key: str, resolution: str) -> Optional[dict]:
    """Mark a flag resolved. ``admin_key`` is the admin's api_key string;
    we store its FK in ``resolved_by_key_id``."""
    admin_key_id = api_key_cache.ensure_id(admin_key)
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """UPDATE user_flags
                       SET resolved_at        = now(),
                           resolved_by_key_id = %s,
                           resolution         = %s
                       WHERE id = %s
                       RETURNING *""",
                (str(admin_key_id) if admin_key_id else None, resolution, flag_id),
            )
            row = cur.fetchone()
            return dict(row) if row else None


# ---------------------------------------------------------------------------
# admin_audit_log
# ---------------------------------------------------------------------------

def audit_log(
    admin_key: str,
    action: str,
    target: Optional[str] = None,
    metadata: Optional[dict] = None,
    *,
    admin_key_id: Optional[str] = None,
) -> None:
    """Append an admin action to the audit log. Pass ``admin_key`` (the
    plain api_key string) and the FK is resolved via the api-key cache,
    OR pass ``admin_key_id`` directly when the caller already has the
    UUID in hand (e.g. read off a contribution row's
    ``approval_requested_by_key_id``)."""
    if admin_key_id is None:
        resolved = api_key_cache.ensure_id(admin_key)
        admin_key_id = str(resolved) if resolved else None
    else:
        admin_key_id = str(admin_key_id) if admin_key_id else None
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO admin_audit_log (admin_key_id, action, target, metadata)
                       VALUES (%s, %s, %s, %s)""",
                (admin_key_id,
                 action, target,
                 json.dumps(metadata) if metadata else None),
            )
    # Mirror into the analytics fact table so the Usage dashboard can
    # render admin activity over time without joining two tables. Imported
    # lazily to avoid a circular import at module load.
    try:
        from . import usage_events
        meta_for_event = dict(metadata) if metadata else {}
        if target is not None:
            meta_for_event.setdefault("target", str(target))
        usage_events.record(
            f"admin.{action}",
            actor_api_key_id=admin_key_id,
            category="admin",
            metadata=meta_for_event or None,
        )
    except Exception:  # pragma: no cover — never block the audit write
        pass


# ---------------------------------------------------------------------------
# Backup download links (shareable, time-limited URLs for R2 backups)
# ---------------------------------------------------------------------------

def create_backup_download_link(
    token: str,
    backup_key: str,
    created_by: str,
    expires_at: datetime,
    label: Optional[str],
) -> dict:
    created_by_id = api_key_cache.ensure_id(created_by)
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO backup_download_links
                       (token, backup_key, created_by_key_id, expires_at, label)
                   VALUES (%s, %s, %s, %s, %s)
                   RETURNING *""",
                (token, backup_key,
                 str(created_by_id) if created_by_id else None,
                 expires_at, label),
            )
            return dict(cur.fetchone())


def get_backup_download_link_by_token(token: str) -> Optional[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM backup_download_links WHERE token = %s",
                (token,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def get_backup_download_link(link_id: int) -> Optional[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM backup_download_links WHERE id = %s",
                (link_id,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def list_backup_download_links() -> List[dict]:
    """All backup download links, newest first, with redemption stats."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT
                    l.*,
                    COALESCE(r.redeem_count, 0)    AS redeem_count,
                    COALESCE(r.success_count, 0)   AS success_count,
                    r.last_redeem_at               AS last_redeem_at
                FROM backup_download_links l
                LEFT JOIN (
                    SELECT link_id,
                           COUNT(*)                                       AS redeem_count,
                           COUNT(*) FILTER (WHERE success)                AS success_count,
                           MAX(redeemed_at)                               AS last_redeem_at
                    FROM backup_download_log
                    GROUP BY link_id
                ) r ON r.link_id = l.id
                ORDER BY l.created_at DESC
                """
            )
            return [dict(r) for r in cur.fetchall()]


def list_backup_download_redemptions(link_id: int) -> List[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, redeemed_at, ip_hash, user_agent, success, failure_reason
                       FROM backup_download_log
                       WHERE link_id = %s
                       ORDER BY redeemed_at DESC""",
                (link_id,),
            )
            return [dict(r) for r in cur.fetchall()]


def revoke_backup_download_link(link_id: int, admin_key: str) -> Optional[dict]:
    """Mark a link revoked. Returns the updated row, or None if missing /
    already revoked (idempotent: re-revoking a revoked link is a no-op)."""
    admin_key_id = api_key_cache.ensure_id(admin_key)
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """UPDATE backup_download_links
                       SET revoked_at = now(), revoked_by_key_id = %s
                       WHERE id = %s AND revoked_at IS NULL
                       RETURNING *""",
                (str(admin_key_id) if admin_key_id else None, link_id),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def record_backup_download_redemption(
    link_id: int,
    *,
    ip_hash: Optional[str],
    user_agent: Optional[str],
    success: bool,
    failure_reason: Optional[str] = None,
) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO backup_download_log
                       (link_id, ip_hash, user_agent, success, failure_reason)
                   VALUES (%s, %s, %s, %s, %s)""",
                (link_id, ip_hash, user_agent, success, failure_reason),
            )
    # Mirror into usage_events for the admin Usage dashboard. No actor key
    # — the redeemer is anonymous (they only have the share-link token).
    try:
        from . import usage_events
        usage_events.record(
            "backup.redeemed" if success else "backup.redeem_failed",
            category="download",
            metadata={
                "link_id": int(link_id),
                "failure_reason": failure_reason,
            },
            ip_hash=ip_hash,
        )
    except Exception:  # pragma: no cover — recorder must not block
        pass


# ---------------------------------------------------------------------------
# Contributions (used by /account/export)
# ---------------------------------------------------------------------------

def list_contributions_for_user(api_key: str) -> List[dict]:
    """All contributions submitted by api_key (any status), for export."""
    if not api_key:
        return []
    key_id = api_key_cache.ensure_id(api_key)
    if key_id is None:
        return []
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, status, contributor, tile_count, created_at,
                          approved_at, tiles_new, tiles_existing, combined_total,
                          withdrawn_at
                       FROM contributions
                       WHERE submitted_by_key_id = %s
                       ORDER BY created_at DESC""",
                (str(key_id),),
            )
            return [dict(r) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Stats cache
# ---------------------------------------------------------------------------

USER_STATS_CACHE_KEY = "user_stats_cache"
USER_STATS_CACHE_TTL_SECONDS = 60


def get_cached_user_stats() -> Optional[dict]:
    """Return cached stats if fresh; else None.

    Stored as JSON `{ "stats": {...}, "cached_at": iso8601 }`.
    """
    val = get_state(USER_STATS_CACHE_KEY)
    if not val:
        return None
    try:
        parsed = json.loads(val)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(parsed, dict):
        return None
    cached_at = parsed.get("cached_at")
    if not cached_at:
        return None
    try:
        ts = datetime.fromisoformat(cached_at)
    except ValueError:
        return None
    if (datetime.now(timezone.utc) - ts).total_seconds() > USER_STATS_CACHE_TTL_SECONDS:
        return None
    return parsed.get("stats") if isinstance(parsed.get("stats"), dict) else None


def set_cached_user_stats(stats: dict) -> None:
    payload = {
        "stats": stats,
        "cached_at": datetime.now(timezone.utc).isoformat(),
    }
    set_state(USER_STATS_CACHE_KEY, json.dumps(payload))


# ---------------------------------------------------------------------------
# Backfill (one-time, idempotent)
# ---------------------------------------------------------------------------

def backfill_users(
    name_generator,
    forbidden_substrings: List[str],
    admin_key: str = "",
    legacy_keys: Optional[List[str]] = None,
) -> dict:
    """Create a `users` row for legacy env-var api_keys that have none.

    Only keys passed in via ``legacy_keys`` (the ``API_KEYS`` env var) and the
    admin key are backfilled. DB-minted keys (from invite-link claims) are
    intentionally skipped — those users must go through ``POST /account/register``
    so ToS acceptance, IP-ban gate, and genesis/shared-IP flag logic apply.

    `name_generator()` must return a candidate display name; we retry until
    we find one that doesn't collide. Also marks the earliest non-deleted
    account on each `bound_identity` as `genesis_for_ip`.

    Returns counts: { "created": int, "genesis_marked": int, "admin_seeded": bool }.
    """
    created = 0

    def _safe_name() -> str:
        for _ in range(50):
            candidate = name_generator()
            lower = candidate.lower()
            if any(s in lower for s in forbidden_substrings):
                continue
            if not display_name_taken(candidate):
                return candidate
        # Fallback: append timestamp
        return f"{name_generator()}-{int(datetime.now().timestamp())}"

    eligible = [k for k in (legacy_keys or []) if k]
    if eligible:
        with get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """SELECT key, id FROM api_keys
                       WHERE key = ANY(%s)
                         AND id NOT IN (SELECT api_key_id FROM users)""",
                    (eligible,),
                )
                missing = [r["key"] for r in cur.fetchall()]

        for key in missing:
            try:
                create_user(key, _safe_name(), terms_version="backfill")
                created += 1
            except psycopg2.Error:
                # If a race or unique violation happens, skip this key.
                pass

    # Seed synthetic admin user
    admin_seeded = False
    if admin_key and not get_user(admin_key):
        # Make sure an api_keys row exists for the admin env-var key so the FK
        # is satisfied. Insert with a permissive permission; revocations etc.
        # do not apply to the env-var key path in auth._resolve_key.
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO api_keys (key, name, permissions, consume_once)
                           VALUES (%s, %s, %s, %s)
                           ON CONFLICT (key) DO NOTHING""",
                    (admin_key, "Synthetic admin user", "contribute", False),
                )
        try:
            create_user(admin_key, "__admin__", terms_version="system")
            admin_seeded = True
        except psycopg2.Error:
            pass

    # Mark genesis_for_ip on the earliest non-deleted account per bound_identity
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """WITH ranked AS (
                       SELECT u.api_key,
                              ROW_NUMBER() OVER (
                                  PARTITION BY ak.bound_identity
                                  ORDER BY u.joined_at ASC
                              ) AS rn,
                              ak.bound_identity
                         FROM users u
                         JOIN api_keys ak ON ak.key = u.api_key
                        WHERE ak.bound_identity IS NOT NULL
                          AND u.deleted_at IS NULL
                          AND u.display_name <> '__admin__'
                   )
                   UPDATE users SET genesis_for_ip = TRUE
                     WHERE api_key IN (SELECT api_key FROM ranked WHERE rn = 1)
                       AND genesis_for_ip = FALSE"""
            )
            genesis_marked = cur.rowcount or 0

    return {"created": created, "genesis_marked": genesis_marked, "admin_seeded": admin_seeded}

"""DB helpers for the community "Groupings Library" feature.

Backs [routes/grouping_library.py](../routes/grouping_library.py). Users publish
local TL groupings (see frontend ``tl-groupings.ts``) so others can browse,
fork, or subscribe. Schema lives in alembic ``0025_grouping_library``.

Conventions (mirrors ``saved_routes_db`` / ``accounts_db``):
  * Author identity is the ``api_keys.id`` UUID stored as text — no FK, so a
    re-key never orphans a published grouping. Display names are resolved
    *live* via a LEFT JOIN on ``users.api_key_id`` so they always reflect the
    author's current privacy choice.
  * ``payload`` JSONB carries ``{"version": int, "tlIds": [...]}``.
  * Denormalised counters (``install_count``, ``upvote_count``) are kept in
    sync by the mutating helpers here.
  * ``user_reputation`` is a cached aggregate recomputed on each activity.
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import psycopg2.extras

from . import database as db


logger = logging.getLogger("app.grouping_library")


# ---------------------------------------------------------------------------
# Reputation scoring (kept here so it can be retuned without a migration)
# ---------------------------------------------------------------------------

_REP_W_PUBLISHED = 2
_REP_W_UPVOTES = 3
_REP_W_INSTALLS = 1
_REP_W_OFFICIAL = 25


def _score(published: int, upvotes: int, installs: int, official: int) -> int:
    return (
        published * _REP_W_PUBLISHED
        + upvotes * _REP_W_UPVOTES
        + installs * _REP_W_INSTALLS
        + official * _REP_W_OFFICIAL
    )


def _payload_hash(tl_ids: List[str]) -> str:
    """Stable content hash of a grouping's TL set.

    Sorted + JSON-encoded so insertion order doesn't matter; matches the
    backfill in alembic ``0026_grouping_library_dedup``.
    """
    normalized = sorted(str(t) for t in tl_ids)
    return hashlib.sha256(
        json.dumps(normalized, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------

def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return str(value)


def _tl_count(payload: Any) -> int:
    if isinstance(payload, dict):
        ids = payload.get("tlIds")
        if isinstance(ids, list):
            return len(ids)
    return 0


def _card_from_row(row: dict, *, viewer_voted: bool = False,
                   viewer_subscribed: bool = False,
                   viewer_install: Optional[dict] = None) -> dict:
    """Shape a browse/detail row into the public card dict."""
    return {
        "id": row["id"],
        "content_type": row["content_type"],
        "name": row["name"],
        "description": row.get("description"),
        "color": row.get("color"),
        "tags": row.get("tags") or [],
        "author": row.get("author_display_name"),
        "author_api_key_id": str(row["author_api_key_id"]) if row.get("author_api_key_id") else None,
        "author_reputation": int(row.get("author_reputation") or 0),
        "is_official": bool(row.get("is_official")),
        "status": row.get("status"),
        "successor_id": row.get("successor_id"),
        "version": int(row.get("version") or 1),
        "tl_count": _tl_count(row.get("payload")),
        "install_count": int(row.get("install_count") or 0),
        "upvote_count": int(row.get("upvote_count") or 0),
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
        "last_edited_at": _iso(row.get("last_edited_at")),
        "viewer_voted": viewer_voted,
        "viewer_subscribed": viewer_subscribed,
        "viewer_install": viewer_install,
    }


# ---------------------------------------------------------------------------
# Publish / edit / unpublish
# ---------------------------------------------------------------------------

def find_duplicate_for_author(
    author_api_key_id: str,
    tl_ids: List[str],
    *,
    exclude_id: Optional[str] = None,
) -> Optional[dict]:
    """Return ``{id, name}`` of an existing *published* grouping owned by the
    same author with the same TL set, or ``None``.

    Used by the publish/edit endpoints to surface a friendly conflict
    response ("you already have a grouping with these TLs") instead of
    silently letting authors spam near-identical entries past the daily cap.
    """
    if not db.is_available():
        return None
    digest = _payload_hash(tl_ids)
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, name FROM shared_groupings
                    WHERE author_api_key_id = %s
                      AND payload_hash = %s
                      AND status = 'published'
                      AND (%s::text IS NULL OR id <> %s)
                    LIMIT 1""",
                (author_api_key_id, digest, exclude_id, exclude_id),
            )
            row = cur.fetchone()
            if row is None:
                return None
            return {"id": row["id"], "name": row["name"]}


def publish_grouping(
    *,
    author_api_key_id: str,
    name: str,
    description: Optional[str],
    color: Optional[str],
    tl_ids: List[str],
    tags: List[str],
    content_type: str = "tl_grouping",
) -> dict:
    """Insert a new published grouping (head row + version 1 snapshot)."""
    if not db.is_available():
        raise RuntimeError("Database not configured")
    gid = str(uuid.uuid4())
    payload = {"version": 1, "tlIds": tl_ids}
    payload_json = json.dumps(payload)
    tags_json = json.dumps(tags)
    payload_hash = _payload_hash(tl_ids)
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO shared_groupings
                       (id, content_type, name, description, color, payload,
                        tags, author_api_key_id, version, last_edited_at,
                        payload_hash)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 1, now(), %s)
                   RETURNING *""",
                (gid, content_type, name, description, color, payload_json,
                 tags_json, author_api_key_id, payload_hash),
            )
            head = dict(cur.fetchone())
            cur.execute(
                """INSERT INTO shared_grouping_versions
                       (grouping_id, version, name, description, color, payload,
                        tags, edited_by_api_key_id, change_note)
                   VALUES (%s, 1, %s, %s, %s, %s, %s, %s, %s)""",
                (gid, name, description, color, payload_json, tags_json,
                 author_api_key_id, "Initial publish"),
            )
    # Reputation recompute is scheduled by the route handler via FastAPI
    # ``BackgroundTasks`` so the publish response returns immediately.
    return head


def edit_grouping(
    *,
    grouping_id: str,
    editor_api_key_id: str,
    name: Optional[str] = None,
    description: Optional[str] = None,
    color: Optional[str] = None,
    tl_ids: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
    change_note: Optional[str] = None,
) -> Optional[dict]:
    """Apply an edit: bump version, append a snapshot, update the head row.

    Returns the updated head row, or ``None`` if the grouping is missing /
    not in ``published`` status.
    """
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM shared_groupings WHERE id = %s FOR UPDATE",
                (grouping_id,),
            )
            head = cur.fetchone()
            if head is None or head["status"] != "published":
                return None
            head = dict(head)
            new_version = int(head["version"]) + 1
            new_name = name if name is not None else head["name"]
            new_desc = description if description is not None else head.get("description")
            new_color = color if color is not None else head.get("color")
            if tl_ids is not None:
                new_payload = {"version": new_version, "tlIds": tl_ids}
            else:
                existing = head.get("payload") or {}
                existing_ids = existing.get("tlIds") if isinstance(existing, dict) else []
                new_payload = {"version": new_version, "tlIds": existing_ids or []}
            new_tags = tags if tags is not None else (head.get("tags") or [])
            payload_json = json.dumps(new_payload)
            tags_json = json.dumps(new_tags)
            new_hash = _payload_hash(new_payload["tlIds"])
            cur.execute(
                """UPDATE shared_groupings
                       SET name = %s, description = %s, color = %s, payload = %s,
                           tags = %s, version = %s, last_edited_at = now(),
                           updated_at = now(), payload_hash = %s
                     WHERE id = %s
                   RETURNING *""",
                (new_name, new_desc, new_color, payload_json, tags_json,
                 new_version, new_hash, grouping_id),
            )
            updated = dict(cur.fetchone())
            cur.execute(
                """INSERT INTO shared_grouping_versions
                       (grouping_id, version, name, description, color, payload,
                        tags, edited_by_api_key_id, change_note)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (grouping_id, new_version, new_name, new_desc, new_color,
                 payload_json, tags_json, editor_api_key_id, change_note),
            )
    # Reputation recompute is scheduled by the route handler via
    # ``BackgroundTasks`` (cheap counters are already reflected on the row).
    return updated


def unpublish_grouping(
    *,
    grouping_id: str,
    actor_api_key_id: str,
    successor_id: Optional[str] = None,
) -> bool:
    """Owner unpublish — soft-retire to ``status='deprecated'``.

    Existing forks/subscriptions keep working (the row stays readable so
    ``list_subscriptions`` can still surface it), but the grouping no longer
    appears in ``browse``. An optional ``successor_id`` points subscribers
    at the replacement grouping. Hard removal stays an admin action via
    :func:`admin_remove`.

    Returns ``True`` if the row transitioned to ``deprecated``.
    """
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE shared_groupings
                       SET status = 'deprecated', successor_id = %s,
                           updated_at = now()
                     WHERE id = %s AND status = 'published'""",
                (successor_id, grouping_id),
            )
            changed = cur.rowcount > 0
    # Reputation recompute is scheduled by the caller via ``BackgroundTasks``.
    return changed


def set_successor(grouping_id: str, successor_id: Optional[str]) -> bool:
    """Set or clear the ``successor_id`` pointer (e.g. after a deprecation)."""
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE shared_groupings
                       SET successor_id = %s, updated_at = now()
                     WHERE id = %s""",
                (successor_id, grouping_id),
            )
            return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------

_HEAD_SELECT = """
    SELECT g.*,
           u.display_name AS author_display_name,
           COALESCE(r.reputation_score, 0) AS author_reputation
      FROM shared_groupings g
      LEFT JOIN users u ON u.api_key_id = g.author_api_key_id::uuid
      LEFT JOIN user_reputation r ON r.api_key_id = g.author_api_key_id
"""


def get_head(grouping_id: str, *, viewer_api_key_id: Optional[str] = None) -> Optional[dict]:
    if not db.is_available():
        return None
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(_HEAD_SELECT + " WHERE g.id = %s", (grouping_id,))
            row = cur.fetchone()
            if row is None:
                return None
            row = dict(row)
            voted, subscribed = _viewer_flags(cur, grouping_id, viewer_api_key_id)
            viewer_install = _viewer_install(cur, grouping_id, viewer_api_key_id)
    card = _card_from_row(row, viewer_voted=voted, viewer_subscribed=subscribed,
                          viewer_install=viewer_install)
    card["tlIds"] = (row.get("payload") or {}).get("tlIds", []) if isinstance(row.get("payload"), dict) else []
    return card


def _viewer_install(cur, grouping_id: str, viewer_api_key_id: Optional[str]) -> Optional[dict]:
    if not viewer_api_key_id:
        return None
    cur.execute(
        """SELECT mode, forked_from_version, synced_version
             FROM shared_grouping_installs
            WHERE grouping_id = %s AND api_key_id = %s""",
        (grouping_id, viewer_api_key_id),
    )
    row = cur.fetchone()
    if row is None:
        return None
    row = dict(row)
    return {
        "mode": row["mode"],
        "forked_from_version": (
            int(row["forked_from_version"]) if row.get("forked_from_version") is not None else None
        ),
        "synced_version": (
            int(row["synced_version"]) if row.get("synced_version") is not None else None
        ),
    }


def _viewer_flags(cur, grouping_id: str, viewer_api_key_id: Optional[str]) -> Tuple[bool, bool]:
    if not viewer_api_key_id:
        return (False, False)
    cur.execute(
        "SELECT 1 FROM shared_grouping_votes WHERE grouping_id = %s AND voter_api_key_id = %s",
        (grouping_id, viewer_api_key_id),
    )
    voted = cur.fetchone() is not None
    cur.execute(
        """SELECT 1 FROM shared_grouping_installs
              WHERE grouping_id = %s AND api_key_id = %s AND mode = 'subscribe'""",
        (grouping_id, viewer_api_key_id),
    )
    subscribed = cur.fetchone() is not None
    return (voted, subscribed)


_SORT_CLAUSES = {
    "popular": "g.upvote_count DESC, g.install_count DESC, g.created_at DESC",
    "installs": "g.install_count DESC, g.upvote_count DESC, g.created_at DESC",
    "recent": "g.created_at DESC",
    "official": "g.is_official DESC, g.upvote_count DESC, g.created_at DESC",
}


def browse(
    *,
    q: Optional[str] = None,
    tag: Optional[str] = None,
    sort: str = "popular",
    official_only: bool = False,
    page: int = 1,
    page_size: int = 20,
    viewer_api_key_id: Optional[str] = None,
) -> dict:
    """Paginated browse of published groupings. Returns ``{items, total, page, page_size}``."""
    if not db.is_available():
        return {"items": [], "total": 0, "page": page, "page_size": page_size}
    order = _SORT_CLAUSES.get(sort, _SORT_CLAUSES["popular"])
    where = ["g.status = 'published'"]
    params: List[Any] = []
    if q:
        where.append("g.name ILIKE %s")
        params.append(f"%{q}%")
    if tag:
        where.append("g.tags @> %s::jsonb")
        params.append(json.dumps([tag]))
    if official_only:
        where.append("g.is_official = TRUE")
    where_sql = " AND ".join(where)
    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    offset = (page - 1) * page_size

    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"SELECT COUNT(*) AS n FROM shared_groupings g WHERE {where_sql}",
                params,
            )
            total = int(cur.fetchone()["n"])
            cur.execute(
                f"{_HEAD_SELECT} WHERE {where_sql} ORDER BY {order} LIMIT %s OFFSET %s",
                params + [page_size, offset],
            )
            rows = [dict(r) for r in cur.fetchall()]
            voted_ids: set = set()
            sub_ids: set = set()
            if viewer_api_key_id and rows:
                ids = [r["id"] for r in rows]
                cur.execute(
                    "SELECT grouping_id FROM shared_grouping_votes "
                    "WHERE voter_api_key_id = %s AND grouping_id = ANY(%s)",
                    (viewer_api_key_id, ids),
                )
                voted_ids = {r["grouping_id"] for r in cur.fetchall()}
                cur.execute(
                    "SELECT grouping_id FROM shared_grouping_installs "
                    "WHERE api_key_id = %s AND mode = 'subscribe' AND grouping_id = ANY(%s)",
                    (viewer_api_key_id, ids),
                )
                sub_ids = {r["grouping_id"] for r in cur.fetchall()}
    items = [
        _card_from_row(
            r,
            viewer_voted=r["id"] in voted_ids,
            viewer_subscribed=r["id"] in sub_ids,
            viewer_install=(
                {"mode": "subscribe", "forked_from_version": None, "synced_version": None}
                if r["id"] in sub_ids else None
            ),
        )
        for r in rows
    ]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


def list_mine(author_api_key_id: str) -> List[dict]:
    if not db.is_available():
        return []
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"{_HEAD_SELECT} WHERE g.author_api_key_id = %s AND g.status != 'removed' "
                "ORDER BY g.updated_at DESC",
                (author_api_key_id,),
            )
            rows = [dict(r) for r in cur.fetchall()]
    return [_card_from_row(r) for r in rows]


def list_history(grouping_id: str) -> List[dict]:
    if not db.is_available():
        return []
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT v.version, v.name, v.change_note, v.payload, v.created_at,
                          v.edited_by_api_key_id, u.display_name AS editor_name
                     FROM shared_grouping_versions v
                     LEFT JOIN users u ON u.api_key_id = v.edited_by_api_key_id::uuid
                    WHERE v.grouping_id = %s
                    ORDER BY v.version DESC""",
                (grouping_id,),
            )
            rows = cur.fetchall()
    return [
        {
            "version": int(r["version"]),
            "name": r["name"],
            "change_note": r["change_note"],
            "tl_count": _tl_count(r["payload"]),
            "editor": r["editor_name"],
            "created_at": _iso(r["created_at"]),
        }
        for r in rows
    ]


def get_version(grouping_id: str, version: int) -> Optional[dict]:
    if not db.is_available():
        return None
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT version, name, description, color, payload, tags, created_at
                     FROM shared_grouping_versions
                    WHERE grouping_id = %s AND version = %s""",
                (grouping_id, version),
            )
            row = cur.fetchone()
            if row is None:
                return None
            row = dict(row)
    payload = row.get("payload") or {}
    return {
        "version": int(row["version"]),
        "name": row["name"],
        "description": row.get("description"),
        "color": row.get("color"),
        "tags": row.get("tags") or [],
        "tlIds": payload.get("tlIds", []) if isinstance(payload, dict) else [],
        "created_at": _iso(row.get("created_at")),
    }


def list_subscriptions(api_key_id: str) -> List[dict]:
    """Return the viewer's subscriptions with the head version so the client
    can detect (and apply) updates."""
    if not db.is_available():
        return []
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT g.id, g.name, g.description, g.color, g.payload, g.tags,
                          g.version AS head_version, g.status, g.successor_id,
                          i.synced_version,
                          u.display_name AS author_display_name
                     FROM shared_grouping_installs i
                     JOIN shared_groupings g ON g.id = i.grouping_id
                     LEFT JOIN users u ON u.api_key_id = g.author_api_key_id::uuid
                    WHERE i.api_key_id = %s AND i.mode = 'subscribe'""",
                (api_key_id,),
            )
            rows = [dict(r) for r in cur.fetchall()]
    out: List[dict] = []
    for r in rows:
        payload = r.get("payload") or {}
        out.append({
            "id": r["id"],
            "name": r["name"],
            "description": r.get("description"),
            "color": r.get("color"),
            "tags": r.get("tags") or [],
            "tlIds": payload.get("tlIds", []) if isinstance(payload, dict) else [],
            "author": r.get("author_display_name"),
            "head_version": int(r["head_version"]),
            "synced_version": int(r["synced_version"]) if r.get("synced_version") is not None else None,
            "status": r.get("status"),
            "successor_id": r.get("successor_id"),
            "has_update": (
                r.get("synced_version") is not None
                and int(r["head_version"]) > int(r["synced_version"])
            ),
        })
    return out


def popular_tags(*, q: Optional[str] = None, limit: int = 20) -> List[dict]:
    """Return the most-used tags across published groupings, optionally
    filtered by a case-insensitive prefix. Powers the publish dialog's tag
    autocomplete so users converge on a canonical vocabulary.

    Returns ``[{tag, count}]`` ordered by descending usage.
    """
    if not db.is_available():
        return []
    prefix = (q or "").strip().lower()
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT tag, COUNT(*)::int AS n
                     FROM shared_groupings g,
                          jsonb_array_elements_text(
                              COALESCE(g.tags, '[]'::jsonb)
                          ) AS tag
                    WHERE g.status = 'published'
                      AND (%s = '' OR tag ILIKE %s || '%%')
                    GROUP BY tag
                    ORDER BY n DESC, tag ASC
                    LIMIT %s""",
                (prefix, prefix, max(1, min(limit, 100))),
            )
            rows = cur.fetchall()
    return [{"tag": r["tag"], "count": int(r["n"])} for r in rows]


# ---------------------------------------------------------------------------
# Votes
# ---------------------------------------------------------------------------

def _bump_reputation_delta(
    cur,
    api_key_id: str,
    *,
    score_delta: int = 0,
    upvotes_delta: int = 0,
    installs_delta: int = 0,
) -> None:
    """Apply a small delta to the cached ``user_reputation`` row in-place.

    Cheap alternative to a full ``recompute_reputation`` aggregate — used on
    high-frequency hot paths (vote/unvote, install/uninstall) so the user
    perceives the response as snappy. ``cur`` must already be inside the
    same transaction so the delta is part of the same write.
    """
    cur.execute(
        """UPDATE user_reputation
               SET reputation_score = GREATEST(reputation_score + %s, 0),
                   total_upvotes_received = GREATEST(total_upvotes_received + %s, 0),
                   total_installs_received = GREATEST(total_installs_received + %s, 0),
                   updated_at = now()
             WHERE api_key_id = %s""",
        (score_delta, upvotes_delta, installs_delta, api_key_id),
    )
    if cur.rowcount == 0:
        # No cached row yet — seed one with zeros and apply the delta. The
        # next full recompute will reconcile any drift.
        cur.execute(
            """INSERT INTO user_reputation
                   (api_key_id, reputation_score, published_count,
                    total_upvotes_received, total_installs_received,
                    official_count)
               VALUES (%s, GREATEST(%s, 0), 0, GREATEST(%s, 0),
                       GREATEST(%s, 0), 0)
               ON CONFLICT (api_key_id) DO NOTHING""",
            (api_key_id, score_delta, upvotes_delta, installs_delta),
        )


def add_vote(grouping_id: str, voter_api_key_id: str) -> Optional[str]:
    """Insert a vote and bump counters.

    Returns the author's ``api_key_id`` (or ``None``) when a new vote was
    recorded so the caller can schedule a deferred reputation recompute via
    FastAPI ``BackgroundTasks``. We *also* apply a cheap delta-update to the
    cached ``user_reputation`` row inline so the next page load already shows
    the new score without waiting on a SUM aggregate.
    """
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO shared_grouping_votes (grouping_id, voter_api_key_id)
                   VALUES (%s, %s)
                   ON CONFLICT (grouping_id, voter_api_key_id) DO NOTHING""",
                (grouping_id, voter_api_key_id),
            )
            if cur.rowcount == 0:
                return None
            cur.execute(
                "UPDATE shared_groupings SET upvote_count = upvote_count + 1 WHERE id = %s "
                "RETURNING author_api_key_id",
                (grouping_id,),
            )
            row = cur.fetchone()
            author = row[0] if row else None
            if author:
                _bump_reputation_delta(
                    cur, author, score_delta=_REP_W_UPVOTES, upvotes_delta=1
                )
    return author


def remove_vote(grouping_id: str, voter_api_key_id: str) -> Optional[str]:
    """Remove a vote and decrement counters. Returns the author id (or None)."""
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM shared_grouping_votes WHERE grouping_id = %s AND voter_api_key_id = %s",
                (grouping_id, voter_api_key_id),
            )
            if cur.rowcount == 0:
                return None
            cur.execute(
                "UPDATE shared_groupings SET upvote_count = GREATEST(upvote_count - 1, 0) "
                "WHERE id = %s RETURNING author_api_key_id",
                (grouping_id,),
            )
            row = cur.fetchone()
            author = row[0] if row else None
            if author:
                _bump_reputation_delta(
                    cur, author, score_delta=-_REP_W_UPVOTES, upvotes_delta=-1
                )
    return author


# ---------------------------------------------------------------------------
# Installs (fork / subscribe)
# ---------------------------------------------------------------------------

def record_install(
    *,
    grouping_id: str,
    api_key_id: str,
    mode: str,
    forked_from_version: Optional[int] = None,
    synced_version: Optional[int] = None,
) -> Tuple[bool, Optional[str]]:
    """Upsert an install row.

    Returns ``(inserted, author_api_key_id)`` — ``inserted`` is ``True`` only
    when a brand-new row was created (so callers bump ``install_count`` once
    per distinct user). ``author_api_key_id`` is returned (when known) so the
    route handler can schedule a deferred full reputation recompute. The
    cheap delta-update to ``user_reputation`` is applied inline.
    """
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO shared_grouping_installs
                       (grouping_id, api_key_id, mode, forked_from_version, synced_version)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (grouping_id, api_key_id) DO UPDATE
                       SET mode = EXCLUDED.mode,
                           forked_from_version = EXCLUDED.forked_from_version,
                           synced_version = EXCLUDED.synced_version,
                           updated_at = now()
                   RETURNING (xmax = 0) AS inserted""",
                (grouping_id, api_key_id, mode, forked_from_version, synced_version),
            )
            inserted = bool(cur.fetchone()[0])
            author: Optional[str] = None
            if inserted:
                cur.execute(
                    "UPDATE shared_groupings SET install_count = install_count + 1 "
                    "WHERE id = %s RETURNING author_api_key_id",
                    (grouping_id,),
                )
                row = cur.fetchone()
                author = row[0] if row else None
                if author:
                    _bump_reputation_delta(
                        cur, author, score_delta=_REP_W_INSTALLS, installs_delta=1
                    )
    return inserted, author


def remove_install(grouping_id: str, api_key_id: str) -> Optional[str]:
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM shared_grouping_installs WHERE grouping_id = %s AND api_key_id = %s",
                (grouping_id, api_key_id),
            )
            if cur.rowcount == 0:
                return None
            cur.execute(
                "UPDATE shared_groupings SET install_count = GREATEST(install_count - 1, 0) "
                "WHERE id = %s RETURNING author_api_key_id",
                (grouping_id,),
            )
            row = cur.fetchone()
            author = row[0] if row else None
            if author:
                _bump_reputation_delta(
                    cur, author, score_delta=-_REP_W_INSTALLS, installs_delta=-1
                )
    return author


def update_synced_version(grouping_id: str, api_key_id: str, version: int) -> None:
    if not db.is_available():
        return
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE shared_grouping_installs
                       SET synced_version = %s, updated_at = now()
                     WHERE grouping_id = %s AND api_key_id = %s AND mode = 'subscribe'""",
                (version, grouping_id, api_key_id),
            )


# ---------------------------------------------------------------------------
# Reports + moderation
# ---------------------------------------------------------------------------

def add_report(*, grouping_id: str, reporter_api_key_id: Optional[str],
               reason: str, details: Optional[str]) -> int:
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO shared_grouping_reports
                       (grouping_id, reporter_api_key_id, reason, details)
                   VALUES (%s, %s, %s, %s) RETURNING id""",
                (grouping_id, reporter_api_key_id, reason, details),
            )
            return int(cur.fetchone()[0])


def count_open_reports() -> int:
    if not db.is_available():
        return 0
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM shared_grouping_reports WHERE status = 'open'")
            return int(cur.fetchone()[0])


def list_open_reports(limit: int = 100) -> List[dict]:
    if not db.is_available():
        return []
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT rp.id, rp.grouping_id, rp.reason, rp.details, rp.created_at,
                          g.name AS grouping_name, g.status AS grouping_status,
                          u.display_name AS reporter_name
                     FROM shared_grouping_reports rp
                     LEFT JOIN shared_groupings g ON g.id = rp.grouping_id
                     LEFT JOIN users u ON u.api_key_id = rp.reporter_api_key_id::uuid
                    WHERE rp.status = 'open'
                    ORDER BY rp.created_at DESC
                    LIMIT %s""",
                (limit,),
            )
            rows = [dict(r) for r in cur.fetchall()]
    return [
        {
            "id": int(r["id"]),
            "grouping_id": r["grouping_id"],
            "grouping_name": r.get("grouping_name"),
            "grouping_status": r.get("grouping_status"),
            "reason": r["reason"],
            "details": r.get("details"),
            "reporter": r.get("reporter_name"),
            "created_at": _iso(r.get("created_at")),
        }
        for r in rows
    ]


def resolve_report(report_id: int, *, resolver_api_key_id: str, dismiss: bool) -> bool:
    if not db.is_available():
        raise RuntimeError("Database not configured")
    new_status = "dismissed" if dismiss else "resolved"
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE shared_grouping_reports
                       SET status = %s, resolved_at = now(), resolved_by = %s
                     WHERE id = %s AND status = 'open'""",
                (new_status, resolver_api_key_id, report_id),
            )
            return cur.rowcount > 0


def admin_remove(grouping_id: str, *, admin_api_key_id: str, reason: Optional[str]) -> Optional[str]:
    """Admin takedown. Returns the author's api_key_id (for reputation recompute)
    or None if the grouping didn't exist / was already removed."""
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE shared_groupings
                       SET status = 'removed', removed_at = now(), removed_by = %s,
                           removed_reason = %s, updated_at = now()
                     WHERE id = %s AND status != 'removed'
                   RETURNING author_api_key_id""",
                (admin_api_key_id, reason, grouping_id),
            )
            row = cur.fetchone()
            # Auto-resolve any open reports for this grouping.
            cur.execute(
                """UPDATE shared_grouping_reports
                       SET status = 'resolved', resolved_at = now(), resolved_by = %s
                     WHERE grouping_id = %s AND status = 'open'""",
                (admin_api_key_id, grouping_id),
            )
            author = row[0] if row else None
    # Reputation recompute is scheduled by the caller via ``BackgroundTasks``.
    return author


def set_official(grouping_id: str, *, is_official: bool) -> Optional[str]:
    """Toggle the verified badge. Returns the author's api_key_id or None."""
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE shared_groupings SET is_official = %s, updated_at = now()
                     WHERE id = %s RETURNING author_api_key_id""",
                (is_official, grouping_id),
            )
            row = cur.fetchone()
            author = row[0] if row else None
    return author


# ---------------------------------------------------------------------------
# Reputation
# ---------------------------------------------------------------------------

def recompute_reputation(api_key_id: str) -> dict:
    """Recompute and upsert the cached reputation aggregate for an author.

    Counts both ``published`` and ``deprecated`` groupings: voluntary retire
    via :func:`unpublish_grouping` doesn't penalise an author's reputation,
    while admin takedowns (``status='removed'``) do drop their score.
    """
    if not db.is_available():
        return {}
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT
                       COUNT(*)::int AS published_count,
                       COALESCE(SUM(upvote_count), 0)::int AS upvotes,
                       COALESCE(SUM(install_count), 0)::int AS installs,
                       COALESCE(SUM(CASE WHEN is_official THEN 1 ELSE 0 END), 0)::int AS official
                     FROM shared_groupings
                    WHERE author_api_key_id = %s
                      AND status IN ('published', 'deprecated')""",
                (api_key_id,),
            )
            row = cur.fetchone() or (0, 0, 0, 0)
            published, upvotes, installs, official = (
                int(row[0]), int(row[1]), int(row[2]), int(row[3])
            )
            score = _score(published, upvotes, installs, official)
            cur.execute(
                """INSERT INTO user_reputation
                       (api_key_id, reputation_score, published_count,
                        total_upvotes_received, total_installs_received,
                        official_count, updated_at)
                   VALUES (%s, %s, %s, %s, %s, %s, now())
                   ON CONFLICT (api_key_id) DO UPDATE
                       SET reputation_score = EXCLUDED.reputation_score,
                           published_count = EXCLUDED.published_count,
                           total_upvotes_received = EXCLUDED.total_upvotes_received,
                           total_installs_received = EXCLUDED.total_installs_received,
                           official_count = EXCLUDED.official_count,
                           updated_at = now()""",
                (api_key_id, score, published, upvotes, installs, official),
            )
    return {
        "reputation_score": score,
        "published_count": published,
        "total_upvotes_received": upvotes,
        "total_installs_received": installs,
        "official_count": official,
    }


def get_reputation(api_key_id: str) -> dict:
    if not db.is_available():
        return {"api_key_id": api_key_id, "display_name": None, "reputation_score": 0}
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT r.reputation_score, r.published_count, r.total_upvotes_received,
                          r.total_installs_received, r.official_count, r.updated_at,
                          u.display_name
                     FROM user_reputation r
                     LEFT JOIN users u ON u.api_key_id = r.api_key_id::uuid
                    WHERE r.api_key_id = %s""",
                (api_key_id,),
            )
            row = cur.fetchone()
            if row is None:
                # No reputation row yet — still surface the display name if the
                # account exists so the UI can render an empty-but-named profile.
                cur.execute(
                    "SELECT display_name FROM users WHERE api_key_id = %s::uuid",
                    (api_key_id,),
                )
                name_row = cur.fetchone()
                display_name = name_row["display_name"] if name_row else None
                return {
                    "api_key_id": api_key_id,
                    "display_name": display_name,
                    "reputation_score": 0,
                    "published_count": 0,
                    "total_upvotes_received": 0,
                    "total_installs_received": 0,
                    "official_count": 0,
                }
            row = dict(row)
    return {
        "api_key_id": api_key_id,
        "display_name": row.get("display_name"),
        "reputation_score": int(row["reputation_score"]),
        "published_count": int(row["published_count"]),
        "total_upvotes_received": int(row["total_upvotes_received"]),
        "total_installs_received": int(row["total_installs_received"]),
        "official_count": int(row["official_count"]),
        "updated_at": _iso(row.get("updated_at")),
    }


def get_owner_id(grouping_id: str) -> Optional[str]:
    """Return the ``author_api_key_id`` for a grouping (any status), or None."""
    if not db.is_available():
        return None
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT author_api_key_id FROM shared_groupings WHERE id = %s",
                (grouping_id,),
            )
            row = cur.fetchone()
            return row[0] if row else None

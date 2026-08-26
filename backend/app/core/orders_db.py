"""DB helpers for the community "Orders" marketplace.

Backs [routes/orders.py](../routes/orders.py). Account holders post Buy/Sell
orders for catalog items; anyone can browse; buyers/sellers send structured
requests and negotiate; the owner logs post-trade fills that feed an
order-local price analytics panel. See plans/session plan + the alembic
migration ``0030_orders_marketplace`` for the schema and full design notes.

Conventions (mirror ``grouping_library_db`` / ``accounts_db``):
  * Identity is the ``api_keys.id`` UUID stored as text — no FK, so a re-key
    never orphans a row. Display names are resolved *live* via a LEFT JOIN on
    ``users.api_key_id`` so they always reflect the trader's current privacy
    choice (``in_game_name`` when ``use_in_game_name`` else ``display_name``).
  * ``quantity_remaining`` is a denormalised counter kept in sync by
    :func:`accept_request`.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional

import psycopg2.extras

from . import database as db


logger = logging.getLogger("app.orders")


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------

def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return str(value)


def _num(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    return float(value)


def _public_name(display_name: Optional[str], in_game_name: Optional[str],
                 use_in_game_name: Any) -> Optional[str]:
    """Pick the name to show publicly, honouring the trader's privacy toggle."""
    if use_in_game_name and in_game_name:
        return in_game_name
    return display_name


def _order_from_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "side": row["side"],
        "item_id": int(row["item_id"]),
        "item_name": row["item_name"],
        "preview_text": row.get("preview_text"),
        "notes": row.get("notes"),
        "unit_price": _num(row.get("unit_price")),
        "quantity": int(row["quantity"]),
        "quantity_remaining": int(row["quantity_remaining"]),
        "sell_unit": row.get("sell_unit") or "unit",
        "stack_size": int(row["stack_size"]) if row.get("stack_size") is not None else None,
        "status": row["status"],
        "location": row.get("location"),
        "mobility": row.get("mobility"),
        "author_api_key_id": str(row["author_api_key_id"]) if row.get("author_api_key_id") else None,
        "author": _public_name(
            row.get("author_display_name"),
            row.get("author_in_game_name"),
            row.get("author_use_in_game_name"),
        ),
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
    }


def _message_from_row(row: dict) -> dict:
    return {
        "id": int(row["id"]),
        "request_id": int(row["request_id"]),
        "kind": row["kind"],
        "proposed_quantity": int(row["proposed_quantity"]) if row.get("proposed_quantity") is not None else None,
        "proposed_unit_price": _num(row.get("proposed_unit_price")),
        "note": row.get("note"),
        "author_api_key_id": str(row["author_api_key_id"]) if row.get("author_api_key_id") else None,
        "author": _public_name(
            row.get("author_display_name"),
            row.get("author_in_game_name"),
            row.get("author_use_in_game_name"),
        ),
        "created_at": _iso(row.get("created_at")),
    }


def _request_from_row(row: dict, messages: Optional[List[dict]] = None) -> dict:
    return {
        "id": int(row["id"]),
        "order_id": row["order_id"],
        "quantity": int(row["quantity"]),
        "proposed_unit_price": _num(row.get("proposed_unit_price")),
        "note": row.get("note"),
        "status": row["status"],
        "requester_api_key_id": str(row["requester_api_key_id"]) if row.get("requester_api_key_id") else None,
        "requester": _public_name(
            row.get("requester_display_name"),
            row.get("requester_in_game_name"),
            row.get("requester_use_in_game_name"),
        ),
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
        "messages": messages if messages is not None else [],
    }


def _fill_from_row(row: dict) -> dict:
    return {
        "id": int(row["id"]),
        "order_id": row["order_id"],
        "request_id": int(row["request_id"]) if row.get("request_id") is not None else None,
        "quantity_reduced": int(row["quantity_reduced"]),
        "reason": row["reason"],
        "unit_price": _num(row.get("unit_price")),
        "publish_analytics": bool(row["publish_analytics"]),
        "flagged": bool(row.get("flagged")),
        "flagged_at": _iso(row.get("flagged_at")),
        "reporter_api_key_id": str(row["reporter_api_key_id"]) if row.get("reporter_api_key_id") else None,
        "counterparty_api_key_id": str(row["counterparty_api_key_id"]) if row.get("counterparty_api_key_id") else None,
        # The offerer's live public name — shown to everyone so the recorded
        # price can be verified with the person who actually traded.
        "counterparty": _public_name(
            row.get("counterparty_display_name"),
            row.get("counterparty_in_game_name"),
            row.get("counterparty_use_in_game_name"),
        ),
        "created_at": _iso(row.get("created_at")),
    }


# JOIN fragment that resolves the author's live public name. Alias the joined
# users columns so ``_order_from_row`` can pick the privacy-honouring name.
_AUTHOR_JOIN = """
    LEFT JOIN users au ON au.api_key_id = o.author_api_key_id::uuid
"""
_AUTHOR_COLS = """
    au.display_name    AS author_display_name,
    au.in_game_name    AS author_in_game_name,
    au.use_in_game_name AS author_use_in_game_name
"""


# ---------------------------------------------------------------------------
# Orders CRUD
# ---------------------------------------------------------------------------

def create_order(
    *,
    author_api_key_id: str,
    side: str,
    item_id: int,
    item_name: str,
    unit_price: float,
    quantity: int,
    preview_text: Optional[str],
    notes: Optional[str],
    location: Optional[dict],
    mobility: Optional[str],
    sell_unit: str = "unit",
    stack_size: Optional[int] = None,
) -> Optional[dict]:
    if not db.is_available():
        raise RuntimeError("Database not configured")
    oid = str(uuid.uuid4())
    loc_json = json.dumps(location) if location is not None else None
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO orders
                       (id, author_api_key_id, side, item_id, item_name,
                        preview_text, notes, unit_price, quantity,
                        quantity_remaining, status, location, mobility,
                        sell_unit, stack_size)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'open', %s, %s, %s, %s)
                   RETURNING id""",
                (oid, author_api_key_id, side, item_id, item_name, preview_text,
                 notes, unit_price, quantity, quantity, loc_json, mobility,
                 sell_unit, stack_size),
            )
    return get_order(oid)


def update_order(
    *,
    order_id: str,
    author_api_key_id: str,
    preview_text: Optional[str] = None,
    notes: Optional[str] = None,
    unit_price: Optional[float] = None,
    quantity: Optional[int] = None,
    location: Optional[dict] = None,
    mobility: Optional[str] = None,
    clear_location: bool = False,
) -> Optional[dict]:
    """Owner edit of an order's mutable fields. Returns the updated order, or
    ``None`` if the order is missing or not owned by ``author_api_key_id``."""
    if not db.is_available():
        raise RuntimeError("Database not configured")
    sets: List[str] = []
    params: List[Any] = []
    if preview_text is not None:
        sets.append("preview_text = %s")
        params.append(preview_text)
    if notes is not None:
        sets.append("notes = %s")
        params.append(notes)
    if unit_price is not None:
        sets.append("unit_price = %s")
        params.append(unit_price)
    if quantity is not None:
        # Reset the total stock and rebase the denormalised remaining counter so
        # the amount already filled (old quantity - old remaining) is preserved.
        # Postgres evaluates SET right-hand sides against the OLD row values, so
        # ``quantity``/``quantity_remaining`` here still refer to the pre-update
        # values.
        sets.append("quantity = %s")
        params.append(quantity)
        sets.append(
            "quantity_remaining = GREATEST(0, %s - (quantity - quantity_remaining))"
        )
        params.append(quantity)
    if mobility is not None:
        sets.append("mobility = %s")
        params.append(mobility)
    if clear_location:
        sets.append("location = NULL")
    elif location is not None:
        sets.append("location = %s")
        params.append(json.dumps(location))
    if not sets:
        return get_order(order_id)
    sets.append("updated_at = now()")
    params.extend([order_id, author_api_key_id])
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""UPDATE orders SET {', '.join(sets)}
                     WHERE id = %s AND author_api_key_id = %s""",
                params,
            )
            if cur.rowcount == 0:
                return None
    return get_order(order_id)


def close_order(order_id: str, author_api_key_id: str) -> bool:
    """Owner closes an order (no longer browseable as open). Idempotent."""
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE orders SET status = 'closed', updated_at = now()
                     WHERE id = %s AND author_api_key_id = %s
                       AND status <> 'closed'""",
                (order_id, author_api_key_id),
            )
            return cur.rowcount > 0


def reopen_order(
    order_id: str, author_api_key_id: str, add_quantity: int = 0
) -> Dict[str, Any]:
    """Owner re-opens a closed/fulfilled order, optionally restocking it.

    ``add_quantity`` is added to both the total quantity and the remaining
    counter, then the status is set back to ``'open'``. The order must end up
    with at least one unit remaining, otherwise there is nothing to sell.

    Returns ``{"ok": True, "order": <order>}`` or ``{"ok": False,
    "error": <code>}`` (``not_found`` / ``no_stock``).
    """
    if not db.is_available():
        raise RuntimeError("Database not configured")
    add = max(0, int(add_quantity))
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT quantity_remaining FROM orders
                     WHERE id = %s AND author_api_key_id = %s
                     FOR UPDATE""",
                (order_id, author_api_key_id),
            )
            row = cur.fetchone()
            if row is None:
                return {"ok": False, "error": "not_found"}
            if int(row["quantity_remaining"]) + add < 1:
                return {"ok": False, "error": "no_stock"}
            cur.execute(
                """UPDATE orders
                       SET quantity = quantity + %s,
                           quantity_remaining = quantity_remaining + %s,
                           status = 'open',
                           updated_at = now()
                     WHERE id = %s""",
                (add, add, order_id),
            )
    return {"ok": True, "order": get_order(order_id)}


def delete_order(order_id: str, actor_key_id: Optional[str], is_admin: bool = False) -> bool:
    """Permanently delete an order and its whole negotiation thread + fills.

    ``ON DELETE CASCADE`` on ``order_requests`` / ``order_negotiation_messages``
    / ``order_fills`` removes the children. Owners may delete their own order;
    admins may delete any order (moderation). Returns True when a row was
    removed.
    """
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            if is_admin:
                cur.execute("DELETE FROM orders WHERE id = %s", (order_id,))
            else:
                cur.execute(
                    "DELETE FROM orders WHERE id = %s AND author_api_key_id = %s",
                    (order_id, actor_key_id),
                )
            return cur.rowcount > 0


def get_order(order_id: str) -> Optional[dict]:
    if not db.is_available():
        return None
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"""SELECT o.*, {_AUTHOR_COLS}
                      FROM orders o {_AUTHOR_JOIN}
                     WHERE o.id = %s""",
                (order_id,),
            )
            row = cur.fetchone()
            return _order_from_row(dict(row)) if row else None


_SORTS = {
    "newest": "o.created_at DESC",
    "oldest": "o.created_at ASC",
    "price_asc": "o.unit_price ASC",
    "price_desc": "o.unit_price DESC",
}


def list_orders(
    *,
    side: Optional[str] = None,
    item_id: Optional[int] = None,
    search: Optional[str] = None,
    mobility: Optional[str] = None,
    status: str = "open",
    include_closed: bool = False,
    sort: str = "newest",
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    if not db.is_available():
        return {"orders": [], "total": 0}
    where: List[str] = []
    params: List[Any] = []
    if not include_closed:
        where.append("o.status = %s")
        params.append(status)
    if side in ("buy", "sell"):
        where.append("o.side = %s")
        params.append(side)
    if item_id is not None:
        where.append("o.item_id = %s")
        params.append(item_id)
    if mobility:
        where.append("o.mobility = %s")
        params.append(mobility)
    if search:
        where.append("o.item_name ILIKE %s")
        params.append(f"%{search}%")
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""
    order_sql = _SORTS.get(sort, _SORTS["newest"])
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"SELECT COUNT(*) AS n FROM orders o{where_sql}", params
            )
            total = int(cur.fetchone()["n"])
            cur.execute(
                f"""SELECT o.*, {_AUTHOR_COLS}
                      FROM orders o {_AUTHOR_JOIN}
                     {where_sql}
                     ORDER BY {order_sql}
                     LIMIT %s OFFSET %s""",
                params + [limit, offset],
            )
            rows = [_order_from_row(dict(r)) for r in cur.fetchall()]
    return {"orders": rows, "total": total}


# ---------------------------------------------------------------------------
# Requests + negotiation
# ---------------------------------------------------------------------------

def create_request(
    *,
    order_id: str,
    requester_api_key_id: str,
    quantity: int,
    proposed_unit_price: Optional[float],
    note: Optional[str],
) -> Optional[dict]:
    """Open a request against an order and seed the first negotiation turn.

    Returns ``None`` if the order does not exist or is not open.
    """
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT status FROM orders WHERE id = %s", (order_id,)
            )
            order = cur.fetchone()
            if order is None or order["status"] != "open":
                return None
            cur.execute(
                """INSERT INTO order_requests
                       (order_id, requester_api_key_id, quantity,
                        proposed_unit_price, note, status)
                   VALUES (%s, %s, %s, %s, %s, 'pending')
                   RETURNING id""",
                (order_id, requester_api_key_id, quantity, proposed_unit_price, note),
            )
            rid = int(cur.fetchone()["id"])
            cur.execute(
                """INSERT INTO order_negotiation_messages
                       (request_id, author_api_key_id, kind, proposed_quantity,
                        proposed_unit_price, note)
                   VALUES (%s, %s, 'offer', %s, %s, %s)""",
                (rid, requester_api_key_id, quantity, proposed_unit_price, note),
            )
    return get_request(rid)


def get_request(request_id: int) -> Optional[dict]:
    if not db.is_available():
        return None
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT r.*,
                          ru.display_name     AS requester_display_name,
                          ru.in_game_name     AS requester_in_game_name,
                          ru.use_in_game_name AS requester_use_in_game_name
                     FROM order_requests r
                     LEFT JOIN users ru ON ru.api_key_id = r.requester_api_key_id::uuid
                    WHERE r.id = %s""",
                (request_id,),
            )
            row = cur.fetchone()
            if row is None:
                return None
            messages = _list_messages(cur, request_id)
    return _request_from_row(dict(row), messages)


def _list_messages(cur, request_id: int) -> List[dict]:
    cur.execute(
        """SELECT m.*,
                  mu.display_name     AS author_display_name,
                  mu.in_game_name     AS author_in_game_name,
                  mu.use_in_game_name AS author_use_in_game_name
             FROM order_negotiation_messages m
             LEFT JOIN users mu ON mu.api_key_id = m.author_api_key_id::uuid
            WHERE m.request_id = %s
            ORDER BY m.created_at ASC, m.id ASC""",
        (request_id,),
    )
    return [_message_from_row(dict(r)) for r in cur.fetchall()]


def list_requests_for_order(order_id: str) -> List[dict]:
    if not db.is_available():
        return []
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT r.*,
                          ru.display_name     AS requester_display_name,
                          ru.in_game_name     AS requester_in_game_name,
                          ru.use_in_game_name AS requester_use_in_game_name
                     FROM order_requests r
                     LEFT JOIN users ru ON ru.api_key_id = r.requester_api_key_id::uuid
                    WHERE r.order_id = %s
                    ORDER BY r.created_at DESC""",
                (order_id,),
            )
            rows = cur.fetchall()
            out: List[dict] = []
            for row in rows:
                messages = _list_messages(cur, int(row["id"]))
                out.append(_request_from_row(dict(row), messages))
    return out


def get_request_context(request_id: int) -> Optional[dict]:
    """Return ``{request_id, order_id, order_owner, requester, status}`` for
    permission checks, or ``None`` if the request is missing."""
    if not db.is_available():
        return None
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT r.id, r.order_id, r.status,
                          r.requester_api_key_id,
                          o.author_api_key_id AS order_owner
                     FROM order_requests r
                     JOIN orders o ON o.id = r.order_id
                    WHERE r.id = %s""",
                (request_id,),
            )
            row = cur.fetchone()
            if row is None:
                return None
            return {
                "request_id": int(row["id"]),
                "order_id": row["order_id"],
                "status": row["status"],
                "requester_api_key_id": str(row["requester_api_key_id"]) if row["requester_api_key_id"] else None,
                "order_owner": str(row["order_owner"]) if row["order_owner"] else None,
            }


def add_message(
    *,
    request_id: int,
    author_api_key_id: str,
    kind: str,
    proposed_quantity: Optional[int],
    proposed_unit_price: Optional[float],
    note: Optional[str],
) -> Optional[dict]:
    """Append a negotiation turn and move the request status accordingly."""
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO order_negotiation_messages
                       (request_id, author_api_key_id, kind, proposed_quantity,
                        proposed_unit_price, note)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (request_id, author_api_key_id, kind, proposed_quantity,
                 proposed_unit_price, note),
            )
            new_status: Optional[str] = None
            if kind == "accept":
                new_status = "accepted"
            elif kind == "reject":
                new_status = "rejected"
            elif kind == "counter":
                new_status = "countered"
            if new_status:
                cur.execute(
                    "UPDATE order_requests SET status = %s, updated_at = now() WHERE id = %s",
                    (new_status, request_id),
                )
            else:
                cur.execute(
                    "UPDATE order_requests SET updated_at = now() WHERE id = %s",
                    (request_id,),
                )
    return get_request(request_id)


def set_request_status(request_id: int, status: str) -> bool:
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE order_requests SET status = %s, updated_at = now() WHERE id = %s",
                (status, request_id),
            )
            return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Fills + order-local analytics
# ---------------------------------------------------------------------------

def _standing_terms(cur, request_id: int) -> Optional[dict]:
    """Fold the negotiation's offer/counter turns into the current agreed terms.

    Walks the ``offer``/``counter`` messages in chronological order, carrying
    forward the most recent non-null quantity and price. Plain ``message`` turns
    (and any chatter after the last proposal) are ignored, so the *latest*
    proposed price/qty always wins. Returns ``{quantity, unit_price,
    last_proposer}`` or ``None`` if the request has no proposals (should not
    happen — the initial offer always seeds one).
    """
    cur.execute(
        """SELECT r.quantity, r.proposed_unit_price, o.unit_price AS order_price
             FROM order_requests r
             JOIN orders o ON o.id = r.order_id
            WHERE r.id = %s""",
        (request_id,),
    )
    base = cur.fetchone()
    if base is None:
        return None
    qty = int(base["quantity"])
    price = base["proposed_unit_price"]
    if price is None:
        price = base["order_price"]
    cur.execute(
        """SELECT author_api_key_id, kind, proposed_quantity, proposed_unit_price
             FROM order_negotiation_messages
            WHERE request_id = %s AND kind IN ('offer', 'counter')
            ORDER BY created_at ASC, id ASC""",
        (request_id,),
    )
    last_proposer: Optional[str] = None
    for msg in cur.fetchall():
        if msg["proposed_quantity"] is not None:
            qty = int(msg["proposed_quantity"])
        if msg["proposed_unit_price"] is not None:
            price = msg["proposed_unit_price"]
        if msg["author_api_key_id"] is not None:
            last_proposer = str(msg["author_api_key_id"])
    return {
        "quantity": qty,
        "unit_price": _num(price),
        "last_proposer": last_proposer,
    }


def accept_request(request_id: int, actor_api_key_id: str) -> Dict[str, Any]:
    """Accept the standing offer/counter, recording the trade automatically.

    Only the *counterparty* of the last proposer may accept (you can't accept
    your own standing offer). The recorded price/qty is the latest agreed terms.
    A fill is written attributed to the offerer (requester) so their public name
    is shown to everyone, and the order's remaining stock is decremented.

    Returns ``{"ok": True, "request": <dict>}`` on success, or
    ``{"ok": False, "error": <code>}`` where ``error`` is one of
    ``not_found`` / ``closed`` / ``not_party`` / ``self_accept`` /
    ``over_fill`` / ``no_terms``.
    """
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT r.status, r.requester_api_key_id, r.order_id,
                          o.author_api_key_id AS order_owner, o.side,
                          o.quantity_remaining, o.status AS order_status
                     FROM order_requests r
                     JOIN orders o ON o.id = r.order_id
                    WHERE r.id = %s
                      FOR UPDATE OF o""",
                (request_id,),
            )
            ctx = cur.fetchone()
            if ctx is None:
                return {"ok": False, "error": "not_found"}
            owner = str(ctx["order_owner"]) if ctx["order_owner"] else None
            requester = str(ctx["requester_api_key_id"]) if ctx["requester_api_key_id"] else None
            actor = str(actor_api_key_id)
            if actor not in (owner, requester):
                return {"ok": False, "error": "not_party"}
            if ctx["status"] in ("accepted", "rejected", "withdrawn"):
                return {"ok": False, "error": "closed"}
            if ctx["order_status"] == "closed":
                return {"ok": False, "error": "closed"}

            terms = _standing_terms(cur, request_id)
            if terms is None:
                return {"ok": False, "error": "no_terms"}
            # You may only accept the *other* party's standing proposal.
            if terms["last_proposer"] is not None and terms["last_proposer"] == actor:
                return {"ok": False, "error": "self_accept"}

            qty = int(terms["quantity"])
            remaining = int(ctx["quantity_remaining"])
            if qty > remaining:
                return {"ok": False, "error": "over_fill"}

            # Append the accept turn + close the request.
            cur.execute(
                """INSERT INTO order_negotiation_messages
                       (request_id, author_api_key_id, kind)
                   VALUES (%s, %s, 'accept')""",
                (request_id, actor),
            )
            cur.execute(
                "UPDATE order_requests SET status = 'accepted', updated_at = now() WHERE id = %s",
                (request_id,),
            )
            # Record the trade — attributed to the offerer (requester), always
            # published (the offerer can flag it false later).
            reason = "sell" if ctx["side"] == "sell" else "buy"
            cur.execute(
                """INSERT INTO order_fills
                       (order_id, reporter_api_key_id, counterparty_api_key_id,
                        request_id, quantity_reduced, reason, unit_price,
                        publish_analytics)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, TRUE)""",
                (ctx["order_id"], actor, requester, request_id, qty, reason,
                 terms["unit_price"]),
            )
            new_remaining = max(0, remaining - qty)
            new_status = "fulfilled" if new_remaining == 0 else "open"
            cur.execute(
                """UPDATE orders
                       SET quantity_remaining = %s,
                           status = CASE WHEN status = 'closed' THEN 'closed' ELSE %s END,
                           updated_at = now()
                     WHERE id = %s""",
                (new_remaining, new_status, ctx["order_id"]),
            )
    return {"ok": True, "request": get_request(request_id)}


def flag_fill(fill_id: int, actor_api_key_id: str, flagged: bool) -> Dict[str, Any]:
    """Let the offerer flag/un-flag their own recorded trade as false.

    Flagged trades are excluded from the price analytics aggregate but remain
    visible in the trade list. Returns ``{"ok": True, "order_id": <id>}`` or
    ``{"ok": False, "error": <code>}`` (``not_found`` / ``forbidden``).
    """
    if not db.is_available():
        raise RuntimeError("Database not configured")
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT order_id, counterparty_api_key_id FROM order_fills WHERE id = %s FOR UPDATE",
                (fill_id,),
            )
            row = cur.fetchone()
            if row is None:
                return {"ok": False, "error": "not_found"}
            counterparty = str(row["counterparty_api_key_id"]) if row["counterparty_api_key_id"] else None
            if counterparty is None or counterparty != str(actor_api_key_id):
                return {"ok": False, "error": "forbidden"}
            cur.execute(
                """UPDATE order_fills
                       SET flagged = %s,
                           flagged_at = CASE WHEN %s THEN now() ELSE NULL END
                     WHERE id = %s""",
                (flagged, flagged, fill_id),
            )
    return {"ok": True, "order_id": row["order_id"]}


def list_fills(order_id: str, *, published_only: bool = False) -> List[dict]:
    if not db.is_available():
        return []
    where = "WHERE f.order_id = %s"
    if published_only:
        where += " AND f.publish_analytics = TRUE"
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"""SELECT f.*,
                          cu.display_name     AS counterparty_display_name,
                          cu.in_game_name     AS counterparty_in_game_name,
                          cu.use_in_game_name AS counterparty_use_in_game_name
                     FROM order_fills f
                     LEFT JOIN users cu
                            ON cu.api_key_id = f.counterparty_api_key_id::uuid
                    {where}
                    ORDER BY f.created_at DESC""",
                (order_id,),
            )
            return [_fill_from_row(dict(r)) for r in cur.fetchall()]


def order_analytics(order_id: str) -> dict:
    """Aggregate published fill prices for the order-local analytics panel.

    Returns ``{published, blocked, count, avg_price, min_price, max_price,
    total_quantity}``. ``blocked`` is True when the owner has logged at least
    one fill but opted every one out of analytics (so the UI can show the
    "Price analytics blocked by <trader>" note).
    """
    if not db.is_available():
        return {"published": False, "blocked": False, "count": 0}
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT
                       COUNT(*) FILTER (WHERE publish_analytics AND NOT flagged AND unit_price IS NOT NULL) AS pub_count,
                       COUNT(*) AS total_count,
                       AVG(unit_price) FILTER (WHERE publish_analytics AND NOT flagged AND unit_price IS NOT NULL) AS avg_price,
                       MIN(unit_price) FILTER (WHERE publish_analytics AND NOT flagged AND unit_price IS NOT NULL) AS min_price,
                       MAX(unit_price) FILTER (WHERE publish_analytics AND NOT flagged AND unit_price IS NOT NULL) AS max_price,
                       SUM(quantity_reduced) FILTER (WHERE publish_analytics AND NOT flagged) AS total_qty
                     FROM order_fills WHERE order_id = %s""",
                (order_id,),
            )
            row = cur.fetchone()
    pub_count = int(row["pub_count"] or 0)
    total_count = int(row["total_count"] or 0)
    return {
        "published": pub_count > 0,
        "blocked": total_count > 0 and pub_count == 0,
        "count": pub_count,
        "avg_price": _num(row["avg_price"]),
        "min_price": _num(row["min_price"]),
        "max_price": _num(row["max_price"]),
        "total_quantity": int(row["total_qty"]) if row["total_qty"] is not None else 0,
    }


# ---------------------------------------------------------------------------
# Trader profile default (per-user location + mobility)
# ---------------------------------------------------------------------------

def get_trader_profile(api_key_id: str) -> dict:
    if not db.is_available():
        return {"default_location": None, "default_mobility": None}
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT orders_default_location, orders_default_mobility
                     FROM users WHERE api_key_id = %s""",
                (api_key_id,),
            )
            row = cur.fetchone()
    if not row:
        return {"default_location": None, "default_mobility": None}
    return {
        "default_location": row["orders_default_location"],
        "default_mobility": row["orders_default_mobility"],
    }


def set_trader_profile(
    api_key_id: str,
    *,
    default_location: Optional[dict],
    default_mobility: Optional[str],
    clear_location: bool = False,
) -> dict:
    if not db.is_available():
        raise RuntimeError("Database not configured")
    loc_sql = "NULL" if clear_location else "%s"
    params: List[Any] = []
    if not clear_location:
        params.append(json.dumps(default_location) if default_location is not None else None)
    params.append(default_mobility)
    params.append(api_key_id)
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""UPDATE users
                       SET orders_default_location = {loc_sql},
                           orders_default_mobility = %s
                     WHERE api_key_id = %s""",
                params,
            )
    return get_trader_profile(api_key_id)


# ---------------------------------------------------------------------------
# Notifications (unread dot)
# ---------------------------------------------------------------------------

def unread_order_ids(api_key_id: str) -> List[str]:
    """IDs of orders with activity this user hasn't seen yet — new requests on
    orders they own, or negotiation replies by others in threads they are party
    to (as owner or requester), newer than their per-order ``order_views``
    marker (falling back to the legacy global ``orders_last_seen_at``)."""
    if not db.is_available():
        return []
    with db.get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT orders_last_seen_at FROM users WHERE api_key_id = %s",
                (api_key_id,),
            )
            row = cur.fetchone()
            if row is None:
                return []
            since = row["orders_last_seen_at"]
            cur.execute(
                """
                WITH activity AS (
                    -- New requests placed on orders I own (by others).
                    SELECT o.id AS order_id, r.created_at AS at
                      FROM order_requests r
                      JOIN orders o ON o.id = r.order_id
                     WHERE o.author_api_key_id = %(uid)s
                       AND r.requester_api_key_id IS DISTINCT FROM %(uid)s
                    UNION ALL
                    -- New messages by others in threads I'm party to.
                    SELECT o.id AS order_id, m.created_at AS at
                      FROM order_negotiation_messages m
                      JOIN order_requests r ON r.id = m.request_id
                      JOIN orders o ON o.id = r.order_id
                     WHERE (o.author_api_key_id = %(uid)s OR r.requester_api_key_id = %(uid)s)
                       AND m.author_api_key_id IS DISTINCT FROM %(uid)s
                )
                SELECT DISTINCT a.order_id
                  FROM activity a
                  LEFT JOIN order_views v
                         ON v.api_key_id = %(uid)s AND v.order_id = a.order_id
                 WHERE COALESCE(v.last_seen_at, %(since)s::timestamptz) IS NULL
                    OR a.at > COALESCE(v.last_seen_at, %(since)s::timestamptz)
                """,
                {"uid": api_key_id, "since": since},
            )
            return [str(r["order_id"]) for r in cur.fetchall()]


def unread_count(api_key_id: str) -> int:
    """Number of orders with unseen activity targeting this user."""
    return len(unread_order_ids(api_key_id))


def mark_seen(api_key_id: str) -> None:
    if not db.is_available():
        return
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET orders_last_seen_at = now() WHERE api_key_id = %s",
                (api_key_id,),
            )


def mark_order_seen(api_key_id: str, order_id: str) -> None:
    """Record that this user has seen the current activity on ``order_id``."""
    if not db.is_available():
        return
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO order_views (api_key_id, order_id, last_seen_at)
                       VALUES (%s, %s, now())
                   ON CONFLICT (api_key_id, order_id)
                   DO UPDATE SET last_seen_at = now()""",
                (api_key_id, order_id),
            )


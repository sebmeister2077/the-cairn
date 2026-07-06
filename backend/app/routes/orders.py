"""Community "Orders" marketplace endpoints (`/api/orders/...`).

A live, account-gated market that is 100% independent of the static Auction
House capture data. Account holders post Buy/Sell orders for catalog items;
anyone can browse. Buyers/sellers send structured requests (qty + optional
proposed price + note) and negotiate via counter-offers; the order owner logs
post-trade fills that feed an order-local price analytics panel.

Gated by the ``orders_enabled`` feature flag — when OFF every endpoint here
returns 404 so the feature is invisible. Writing requires an account
(``require_active_user``); reads are public.

See the alembic migration ``0030_orders_marketplace`` + [orders_db.py](../core/orders_db.py).
"""

from __future__ import annotations

import logging
import re
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_active_user, resolve_key_id
from ..core import api_key_cache
from ..core import feature_flags
from ..core import orders_db as odb
from ..rate_limiter import check_scoped_rate_limit


logger = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/orders", tags=["orders"])

_FLAG_KEY = "orders_enabled"
_FLAG_OFF = HTTPException(status_code=404, detail="Not found")
_DAY = 86400

_PREVIEW_MAX = 40
_NOTES_MAX = 200
_NOTE_MAX = 200
_ITEM_NAME_MAX = 120
_LABEL_MAX = 60

_SIDES = {"buy", "sell"}
_MOBILITY = {"stationary", "occasional", "frequent"}
_SELL_UNITS = {"unit", "stack", "crate"}
_LOC_SOURCES = {"manual", "landmark", "favorite"}
_SORTS = {"newest", "oldest", "price_asc", "price_desc"}
_MSG_KINDS = {"message", "counter"}

# Rate-limit caps (per API key, rolling 24h).
_CREATE_CAP = 30
_REQUEST_CAP = 60
_MESSAGE_CAP = 200
_FLAG_CAP = 100


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class LocationBody(BaseModel):
    source: str = Field(..., max_length=16)
    x: int
    z: int
    label: Optional[str] = Field(default=None, max_length=_LABEL_MAX)
    landmark_id: Optional[str] = Field(default=None, max_length=80)


class CreateOrderBody(BaseModel):
    side: str
    item_id: int = Field(..., ge=0)
    item_name: str = Field(..., min_length=1, max_length=_ITEM_NAME_MAX)
    unit_price: float = Field(..., gt=0)
    quantity: int = Field(..., ge=1)
    preview_text: Optional[str] = Field(default=None, max_length=_PREVIEW_MAX)
    notes: Optional[str] = Field(default=None, max_length=_NOTES_MAX)
    location: Optional[LocationBody] = None
    mobility: Optional[str] = None
    sell_unit: str = "unit"
    stack_size: Optional[int] = Field(default=None, ge=1)
    save_as_default: bool = False


class UpdateOrderBody(BaseModel):
    unit_price: Optional[float] = Field(default=None, gt=0)
    quantity: Optional[int] = Field(default=None, ge=1)
    preview_text: Optional[str] = Field(default=None, max_length=_PREVIEW_MAX)
    notes: Optional[str] = Field(default=None, max_length=_NOTES_MAX)
    location: Optional[LocationBody] = None
    clear_location: bool = False
    mobility: Optional[str] = None


class RequestBody(BaseModel):
    quantity: int = Field(..., ge=1)
    proposed_unit_price: Optional[float] = Field(default=None, gt=0)
    note: Optional[str] = Field(default=None, max_length=_NOTE_MAX)


class MessageBody(BaseModel):
    kind: str = "message"
    proposed_quantity: Optional[int] = Field(default=None, ge=1)
    proposed_unit_price: Optional[float] = Field(default=None, gt=0)
    note: Optional[str] = Field(default=None, max_length=_NOTE_MAX)


class FlagFillBody(BaseModel):
    flagged: bool = True


class ProfileBody(BaseModel):
    location: Optional[LocationBody] = None
    clear_location: bool = False
    mobility: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ensure_enabled() -> None:
    if not feature_flags.is_feature_enabled(_FLAG_KEY):
        raise _FLAG_OFF


def _key_id_for(api_key: str) -> str:
    kid = api_key_cache.ensure_id(api_key)
    if kid is None:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return str(kid)


def _clean_text(raw: Optional[str], max_len: int) -> Optional[str]:
    if raw is None:
        return None
    cleaned = re.sub(r"[\x00-\x1f<>]", "", raw).strip()
    if not cleaned:
        return None
    return cleaned[:max_len]


def _clean_location(loc: Optional[LocationBody]) -> Optional[dict]:
    if loc is None:
        return None
    if loc.source not in _LOC_SOURCES:
        raise HTTPException(status_code=400, detail="Invalid location source")
    return {
        "source": loc.source,
        "x": int(loc.x),
        "z": int(loc.z),
        "label": _clean_text(loc.label, _LABEL_MAX),
        "landmark_id": _clean_text(loc.landmark_id, 80),
    }


def _clean_mobility(mobility: Optional[str]) -> Optional[str]:
    if mobility is None:
        return None
    if mobility not in _MOBILITY:
        raise HTTPException(status_code=400, detail="Invalid mobility value")
    return mobility


# ---------------------------------------------------------------------------
# Public reads
# ---------------------------------------------------------------------------

@router.get("")
async def list_orders(
    side: Optional[str] = None,
    item_id: Optional[int] = None,
    q: Optional[str] = None,
    mobility: Optional[str] = None,
    sort: str = "newest",
    include_closed: bool = False,
    limit: int = 50,
    offset: int = 0,
):
    _ensure_enabled()
    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))
    if sort not in _SORTS:
        sort = "newest"
    if side is not None and side not in _SIDES:
        side = None
    if mobility is not None and mobility not in _MOBILITY:
        mobility = None
    return odb.list_orders(
        side=side,
        item_id=item_id,
        search=_clean_text(q, 120),
        mobility=mobility,
        include_closed=bool(include_closed),
        sort=sort,
        limit=limit,
        offset=offset,
    )


@router.get("/notifications/count")
async def notifications_count(
    ctx: dict = Depends(require_active_user),
):
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    return {"unread": odb.unread_count(kid)}


@router.get("/notifications/orders")
async def notifications_unread_orders(
    ctx: dict = Depends(require_active_user),
):
    """IDs of the orders that have unseen activity for the caller, so the UI can
    dot the specific orders (not just the global nav button)."""
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    return {"order_ids": odb.unread_order_ids(kid)}


@router.post("/notifications/seen")
async def notifications_seen(
    ctx: dict = Depends(require_active_user),
):
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    odb.mark_seen(kid)
    return {"ok": True}


@router.get("/profile")
async def get_profile(
    ctx: dict = Depends(require_active_user),
):
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    return odb.get_trader_profile(kid)


@router.put("/profile")
async def put_profile(
    body: ProfileBody,
    ctx: dict = Depends(require_active_user),
):
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    return odb.set_trader_profile(
        kid,
        default_location=_clean_location(body.location),
        default_mobility=_clean_mobility(body.mobility),
        clear_location=bool(body.clear_location),
    )


@router.get("/{order_id}")
async def get_order(
    order_id: str,
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    _ensure_enabled()
    order = odb.get_order(order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    # Reads are public, but negotiation threads are private: the order owner
    # sees every request while any other viewer only receives their own. We
    # resolve the (optional) API key here without forcing auth so anonymous
    # visitors can still browse the order.
    viewer_kid = str(resolve_key_id(x_api_key)) if x_api_key else None
    requests = odb.list_requests_for_order(order_id)
    is_owner = viewer_kid is not None and order.get("author_api_key_id") == viewer_kid
    if not is_owner:
        requests = [
            r for r in requests if r.get("requester_api_key_id") == viewer_kid
        ]
    order["requests"] = requests
    # Only expose trades the seller published for analytics — unpublished fills
    # stay private (they still power the aggregate "blocked" state below).
    order["fills"] = odb.list_fills(order_id, published_only=True)
    order["analytics"] = odb.order_analytics(order_id)
    return order


# ---------------------------------------------------------------------------
# Authenticated writes
# ---------------------------------------------------------------------------

@router.post("")
async def create_order(
    body: CreateOrderBody,
    ctx: dict = Depends(require_active_user),
):
    _ensure_enabled()
    if body.side not in _SIDES:
        raise HTTPException(status_code=400, detail="side must be 'buy' or 'sell'")
    kid = _key_id_for(ctx["key"])
    check_scoped_rate_limit(ctx["key"], "orders-create", _CREATE_CAP, _DAY)
    location = _clean_location(body.location)
    mobility = _clean_mobility(body.mobility)
    sell_unit = body.sell_unit if body.sell_unit in _SELL_UNITS else "unit"
    if sell_unit == "unit":
        stack_size = None
    else:
        if body.stack_size is None or body.stack_size < 1:
            raise HTTPException(
                status_code=400,
                detail="stack_size is required when selling by stack or crate",
            )
        stack_size = int(body.stack_size)
    order = odb.create_order(
        author_api_key_id=kid,
        side=body.side,
        item_id=body.item_id,
        item_name=_clean_text(body.item_name, _ITEM_NAME_MAX) or body.item_name[:_ITEM_NAME_MAX],
        unit_price=body.unit_price,
        quantity=body.quantity,
        preview_text=_clean_text(body.preview_text, _PREVIEW_MAX),
        notes=_clean_text(body.notes, _NOTES_MAX),
        location=location,
        mobility=mobility,
        sell_unit=sell_unit,
        stack_size=stack_size,
    )
    if order is None:
        raise HTTPException(status_code=500, detail="Failed to create order")
    if body.save_as_default:
        odb.set_trader_profile(
            kid, default_location=location, default_mobility=mobility
        )
    return order


@router.patch("/{order_id}")
async def update_order(
    order_id: str,
    body: UpdateOrderBody,
    ctx: dict = Depends(require_active_user),
):
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    order = odb.update_order(
        order_id=order_id,
        author_api_key_id=kid,
        preview_text=_clean_text(body.preview_text, _PREVIEW_MAX),
        notes=_clean_text(body.notes, _NOTES_MAX),
        unit_price=body.unit_price,
        quantity=body.quantity,
        location=_clean_location(body.location),
        mobility=_clean_mobility(body.mobility),
        clear_location=bool(body.clear_location),
    )
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found or not yours")
    return order


@router.post("/{order_id}/close")
async def close_order(
    order_id: str,
    ctx: dict = Depends(require_active_user),
):
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    if not odb.close_order(order_id, kid):
        raise HTTPException(status_code=404, detail="Order not found or not yours")
    return {"ok": True}


@router.post("/{order_id}/seen")
async def mark_order_seen(
    order_id: str,
    ctx: dict = Depends(require_active_user),
):
    """Clear the unread marker for a single order once the caller views it."""
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    odb.mark_order_seen(kid, order_id)
    return {"ok": True}


@router.post("/{order_id}/requests")
async def create_request(
    order_id: str,
    body: RequestBody,
    ctx: dict = Depends(require_active_user),
):
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    order = odb.get_order(order_id)
    if order is None or order["status"] != "open":
        raise HTTPException(status_code=404, detail="Order not open")
    if order.get("author_api_key_id") == kid:
        raise HTTPException(status_code=400, detail="You cannot request your own order")
    check_scoped_rate_limit(ctx["key"], "orders-request", _REQUEST_CAP, _DAY)
    req = odb.create_request(
        order_id=order_id,
        requester_api_key_id=kid,
        quantity=body.quantity,
        proposed_unit_price=body.proposed_unit_price,
        note=_clean_text(body.note, _NOTE_MAX),
    )
    if req is None:
        raise HTTPException(status_code=404, detail="Order not open")
    return req


@router.post("/requests/{request_id}/messages")
async def post_message(
    request_id: int,
    body: MessageBody,
    ctx: dict = Depends(require_active_user),
):
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    context = odb.get_request_context(request_id)
    if context is None:
        raise HTTPException(status_code=404, detail="Request not found")
    if kid not in (context["order_owner"], context["requester_api_key_id"]):
        raise HTTPException(status_code=403, detail="Not a party to this request")
    if context["status"] in ("accepted", "rejected", "withdrawn"):
        raise HTTPException(status_code=409, detail="This request is closed")
    if body.kind not in _MSG_KINDS:
        raise HTTPException(status_code=400, detail="Invalid message kind")
    check_scoped_rate_limit(ctx["key"], "orders-message", _MESSAGE_CAP, _DAY)
    return odb.add_message(
        request_id=request_id,
        author_api_key_id=kid,
        kind=body.kind,
        proposed_quantity=body.proposed_quantity,
        proposed_unit_price=body.proposed_unit_price,
        note=_clean_text(body.note, _NOTE_MAX),
    )


@router.post("/requests/{request_id}/accept")
async def accept_request(
    request_id: int,
    ctx: dict = Depends(require_active_user),
):
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    check_scoped_rate_limit(ctx["key"], "orders-message", _MESSAGE_CAP, _DAY)
    result = odb.accept_request(request_id, kid)
    if result.get("ok"):
        return result["request"]
    error = result.get("error")
    if error == "not_found":
        raise HTTPException(status_code=404, detail="Request not found")
    if error == "not_party":
        raise HTTPException(status_code=403, detail="Not a party to this request")
    if error == "self_accept":
        raise HTTPException(
            status_code=403,
            detail="You can't accept your own offer — wait for the other party to accept.",
        )
    if error == "over_fill":
        raise HTTPException(
            status_code=409,
            detail="The agreed quantity exceeds the order's remaining stock. Re-negotiate the amount.",
        )
    # closed / no_terms
    raise HTTPException(status_code=409, detail="This request can no longer be accepted")


@router.post("/requests/{request_id}/reject")
async def reject_request(
    request_id: int,
    ctx: dict = Depends(require_active_user),
):
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    context = odb.get_request_context(request_id)
    if context is None:
        raise HTTPException(status_code=404, detail="Request not found")
    if kid not in (context["order_owner"], context["requester_api_key_id"]):
        raise HTTPException(status_code=403, detail="Not a party to this request")
    if context["status"] in ("accepted", "rejected", "withdrawn"):
        raise HTTPException(status_code=409, detail="This request is closed")
    return odb.add_message(
        request_id=request_id, author_api_key_id=kid, kind="reject",
        proposed_quantity=None, proposed_unit_price=None, note=None,
    )


@router.post("/requests/{request_id}/withdraw")
async def withdraw_request(
    request_id: int,
    ctx: dict = Depends(require_active_user),
):
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    context = odb.get_request_context(request_id)
    if context is None:
        raise HTTPException(status_code=404, detail="Request not found")
    if kid != context["requester_api_key_id"]:
        raise HTTPException(status_code=403, detail="Only the requester can withdraw")
    if context["status"] in ("accepted", "rejected", "withdrawn"):
        raise HTTPException(status_code=409, detail="This request is closed")
    odb.set_request_status(request_id, "withdrawn")
    return odb.get_request(request_id)


@router.post("/fills/{fill_id}/flag")
async def flag_fill(
    fill_id: int,
    body: FlagFillBody,
    ctx: dict = Depends(require_active_user),
):
    """Let the offerer flag (or un-flag) their own recorded trade as false.

    Flagged trades drop out of the price analytics aggregate but stay visible in
    the trade list with a "Flagged" marker. Only the offerer (counterparty of
    the trade) may toggle their own flag.
    """
    _ensure_enabled()
    kid = _key_id_for(ctx["key"])
    check_scoped_rate_limit(ctx["key"], "orders-flag", _FLAG_CAP, _DAY)
    result = odb.flag_fill(fill_id, kid, bool(body.flagged))
    if not result.get("ok"):
        error = result.get("error")
        if error == "not_found":
            raise HTTPException(status_code=404, detail="Trade not found")
        raise HTTPException(status_code=403, detail="Only the offerer can flag this trade")
    order_id = result["order_id"]
    order = odb.get_order(order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    order["fills"] = odb.list_fills(order_id, published_only=True)
    order["analytics"] = odb.order_analytics(order_id)
    return order

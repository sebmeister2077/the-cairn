#!/usr/bin/env python3
"""Preprocess the raw Auction House capture (JSONL) into compact, pre-aggregated
JSON artifacts consumed by the frontend Auction House explorer.

Run manually whenever the raw capture is refreshed:

    python backend/process_auction_data.py

Inputs
------
- Raw capture:   frontend/src/assets/Auction/auction-events.jsonl
- Item map (optional): backend/auction_item_map.json
      { "<itemId>": {"code": "game:ingot-copper", "name": "Copper ingot",
                      "category": "ingot"}, ... }
  If absent (or an id is missing), the numeric id is used as the name and a
  category is heuristically derived from the code when available.

Outputs (written to frontend/public/auction/)
--------------------------------------------
- listings.json   compact one-row-per-auction records (no RawHex)
- summary.json    precomputed aggregates (per-item stats, leaderboards, heatmap
                  bins, market totals, time series, generatedUtc)
- items.json      itemId -> {name, category, code, classType, maxStackSize}

Key data rules (see plans/auction-house-explorer-plan.md):
- Dedup to the newest row per AuctionId (raw file has partial duplicates as an
  auction moves Active -> Sold -> SoldRetrieved / Expired).
- Item.Id / Item.StackSize in the JSON are unreliable; decode Item.RawHex.
- Players identified by Uid; auctioneers clustered by rounded coordinates.
- Fair-price / medians computed from SOLD listings only.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import struct
import zlib
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT = REPO_ROOT / "frontend" / "src" / "assets" / "Auction" / "auction-events.jsonl"
DEFAULT_ITEM_MAP = REPO_ROOT / "backend" / "auction_item_map.json"
# Game registry mapping numeric item/block ids to their codes (split into
# "Items" and "Blocks"). Exported from the server; used to resolve human
# readable names when an explicit item map entry is missing.
DEFAULT_REGISTRY = (
    REPO_ROOT / "frontend" / "src" / "assets" / "Auction" / "registry-tops.vintagestory.at.json"
)
DEFAULT_OUTPUT_DIR = REPO_ROOT / "frontend" / "public" / "auction"

# States that mean the auction actually sold.
SOLD_STATES = {"Sold", "SoldRetrieved"}
# Terminal (completed) states, preferred when deduplicating.
TERMINAL_STATES = {"Sold", "SoldRetrieved", "Expired"}

# Heatmap grid resolution in world blocks.
HEATMAP_BIN = 512
# Auctioneer clustering resolution in world blocks.
AUCTIONEER_BIN = 8

# The auction event coordinates are absolute world blocks, but the webmap
# (and the in-game HUD) display coordinates relative to the map centre.
# Convert absolute -> map-relative by subtracting the map middle. 512000 is
# the default for a 1,024,000-block world (see backend/app/core/mapdb.py's
# DEFAULT_MAP_MIDDLE and config_reader.get_map_offsets).
MAP_MIDDLE = 512000


def _to_relative(value: Any) -> float:
    """Convert an absolute world coordinate to map-relative. Zero/None means
    "unknown" and is preserved as 0.0 so downstream truthiness checks (e.g.
    delivery destination present?) keep working."""
    v = float(value or 0.0)
    return v - MAP_MIDDLE if v else 0.0


# --------------------------------------------------------------------------- #
# Deposit fee
# --------------------------------------------------------------------------- #
# When a seller lists an auction they pay a non-refundable deposit (separate
# from the TraderCut sale commission and the delivery fee). It is set by the
# listing duration in weeks. The raw capture carries the duration as
# `InitialDurationHours`; one in-game week is 168 hours.
HOURS_PER_WEEK = 168
DEPOSIT_FEE_BY_WEEKS = {
    3: 1,
    5: 1,
    6: 2,
    10: 2,
    9: 3,
    15: 3,
    12: 4,
    20: 4,
    25: 5,
}


def deposit_fee_for_hours(initial_duration_hours: Any) -> int:
    """Deposit (in gears) the seller paid to list the auction, derived from its
    initial duration. Returns 0 when the duration is missing or doesn't match a
    known listing-length option."""
    hours = float(initial_duration_hours or 0)
    if hours <= 0:
        return 0
    weeks = round(hours / HOURS_PER_WEEK)
    return DEPOSIT_FEE_BY_WEEKS.get(weeks, 0)


# --------------------------------------------------------------------------- #
# RawHex ItemStack decoding
# --------------------------------------------------------------------------- #
# Vintage Story TreeAttribute type ids (subset we can decode safely).
ATTR_INT = 1
ATTR_LONG = 2
ATTR_DOUBLE = 3
ATTR_FLOAT = 4
ATTR_STRING = 5
ATTR_TREE = 6
ATTR_BOOL = 9


class _Reader:
    """Minimal little-endian binary reader matching .NET BinaryReader semantics."""

    def __init__(self, buf: bytes):
        self.buf = buf
        self.pos = 0

    def _take(self, n: int) -> bytes:
        if self.pos + n > len(self.buf):
            raise EOFError("unexpected end of ItemStack bytes")
        chunk = self.buf[self.pos : self.pos + n]
        self.pos += n
        return chunk

    def byte(self) -> int:
        return self._take(1)[0]

    def int32(self) -> int:
        return struct.unpack("<i", self._take(4))[0]

    def int64(self) -> int:
        return struct.unpack("<q", self._take(8))[0]

    def float32(self) -> float:
        return struct.unpack("<f", self._take(4))[0]

    def double(self) -> float:
        return struct.unpack("<d", self._take(8))[0]

    def string(self) -> str:
        # .NET BinaryWriter uses a 7-bit-encoded length prefix.
        length = 0
        shift = 0
        while True:
            b = self.byte()
            length |= (b & 0x7F) << shift
            if (b & 0x80) == 0:
                break
            shift += 7
        return self._take(length).decode("utf-8", errors="replace")


def _read_tree(r: _Reader) -> Dict[str, Any]:
    """Best-effort parse of a TreeAttribute. Stops at the 0 end-marker or on an
    attribute type we don't decode (returns whatever was parsed so far)."""
    out: Dict[str, Any] = {}
    while True:
        attr_id = r.byte()
        if attr_id == 0:
            break
        key = r.string()
        if attr_id == ATTR_INT:
            out[key] = r.int32()
        elif attr_id == ATTR_LONG:
            out[key] = r.int64()
        elif attr_id == ATTR_DOUBLE:
            out[key] = r.double()
        elif attr_id == ATTR_FLOAT:
            out[key] = round(r.float32(), 6)
        elif attr_id == ATTR_STRING:
            out[key] = r.string()
        elif attr_id == ATTR_BOOL:
            out[key] = bool(r.byte())
        elif attr_id == ATTR_TREE:
            out[key] = _read_tree(r)
        else:
            # Unknown / complex type (ItemstackAttribute, arrays…). We can't
            # reliably advance past it, so stop attribute parsing here.
            out["_partial"] = True
            break
    return out


def decode_itemstack(raw_hex: Optional[str]) -> Optional[Dict[str, Any]]:
    """Decode a serialized ItemStack. Returns classType/itemId/stackSize plus a
    best-effort attribute dict, or None if the base header can't be read."""
    if not raw_hex:
        return None
    try:
        r = _Reader(bytes.fromhex(raw_hex))
        class_type = r.int32()  # 1 = Item, 0 = Block
        item_id = r.int32()
        stack_size = r.int32()
    except (ValueError, EOFError):
        return None

    attrs: Dict[str, Any] = {}
    try:
        attrs = _read_tree(r)
    except EOFError:
        pass

    return {
        "classType": "Item" if class_type == 1 else "Block",
        "itemId": item_id,
        "stackSize": max(1, stack_size),
        "attributes": attrs,
    }


# --------------------------------------------------------------------------- #
# Item map / naming
# --------------------------------------------------------------------------- #
def load_item_map(path: Path) -> Dict[str, Dict[str, str]]:
    if not path.exists():
        print(f"[warn] item map not found at {path} — falling back to raw item ids")
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    # Normalise keys to str.
    return {str(k): v for k, v in data.items()}


def load_registry(path: Path) -> Dict[str, Dict[str, str]]:
    """Load the game registry keyed by class type.

    Returns ``{"Item": {"<id>": code}, "Block": {...}, "ItemNames": {"<id>":
    name}, "BlockNames": {...}}`` with string keys so lookups match the decoded
    ``classType`` ("Item"/"Block"). Item and block ids share the same numeric
    space, so they must be kept in separate maps and disambiguated by class type.

    The ``*Names`` maps carry the game's proper localized display names (e.g.
    "Sturdy leather"); the code maps are the fallback used to derive a category
    and a humanized name when no proper name exists.
    """
    if not path.exists():
        print(f"[warn] registry not found at {path} — item names will fall back to ids")
        return {"Item": {}, "Block": {}, "ItemNames": {}, "BlockNames": {}, "ItemStack": {}, "BlockStack": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {
        "Item": {str(k): v for k, v in (data.get("Items") or {}).items()},
        "Block": {str(k): v for k, v in (data.get("Blocks") or {}).items()},
        "ItemNames": {str(k): v for k, v in (data.get("ItemNames") or {}).items()},
        "BlockNames": {str(k): v for k, v in (data.get("BlockNames") or {}).items()},
        # Real in-game maximum stack size per id (from Packet_Item/BlockType.MaxStackSize,
        # sniffed off the join handshake). Absent ids simply have no known stack size.
        "ItemStack": {str(k): v for k, v in (data.get("ItemStackSizes") or {}).items()},
        "BlockStack": {str(k): v for k, v in (data.get("BlockStackSizes") or {}).items()},
    }


def _category_from_code(code: str) -> str:
    # e.g. "game:ingot-copper" -> "ingot"; "game:drygrass" -> "drygrass".
    tail = code.split(":", 1)[-1]
    return tail.split("-", 1)[0] or "misc"


def humanize_code(code: str) -> str:
    """Turn a bare item code into a readable display name.

    e.g. "game:ingot-copper" -> "Ingot copper"; "blade-falx-iron" ->
    "Blade falx iron". Not the exact in-game lang string (which we don't have),
    but far more useful than a numeric id.
    """
    tail = code.split(":", 1)[-1]
    words = tail.replace("_", "-").split("-")
    words = [w for w in words if w]
    if not words:
        return code
    text = " ".join(words)
    return text[:1].upper() + text[1:]


def resolve_item(
    stack: Dict[str, Any],
    raw_item: Dict[str, Any],
    item_map: Dict[str, Dict[str, str]],
    registry: Dict[str, Dict[str, str]],
) -> Dict[str, Any]:
    item_id = stack["itemId"]
    class_type = stack["classType"]
    key = str(item_id)
    mapped = item_map.get(key, {})
    # Each auction event now ships the item's human-readable display name and
    # code (Item.Name / Item.Code), so prefer those. Fall back to an explicit
    # item map entry, then the game registry code for this id within its class
    # type (Item vs Block), and finally a humanised code / raw id.
    event_name = (raw_item.get("Name") or "").strip() or None
    event_code = (raw_item.get("Code") or "").strip() or None
    code = event_code or mapped.get("code") or registry.get(class_type, {}).get(key)
    # The registry's proper localized display name (e.g. "Sturdy leather"),
    # preferred over a name humanized from the raw code ("Leather sturdy plain").
    registry_name = registry.get(f"{class_type}Names", {}).get(key)
    name = (
        event_name
        or mapped.get("name")
        or registry_name
        or (humanize_code(code) if code else f"#{item_id}")
    )
    category = mapped.get("category") or (_category_from_code(code) if code else "unknown")
    # Real in-game max stack size for this id (from the game registry). Keyed by the
    # original decoded id/class — before any clutter/tapestry variant remap — since the
    # underlying block/item is what actually defines the stack size.
    max_stack = registry.get(f"{class_type}Stack", {}).get(key)
    return {
        "itemId": item_id,
        "name": name,
        "code": code,
        "category": category,
        "classType": class_type,
        "maxStackSize": max_stack,
    }


# --------------------------------------------------------------------------- #
# Type-variant splitting (clutter, tapestry)
# --------------------------------------------------------------------------- #
# Some in-game objects are a single block id whose actual object lives in the
# stack's `type` attribute:
#   * "clutter"  — e.g. "toy7", "pile-cloth2", "chains/chain-ceiling-hook".
#   * "tapestry" — e.g. "ambush1", "rotbeast11", "schematic-c-bloody2" (big
#                  tapestries are split into numbered pieces of one artwork).
# The market treats each as one item ("Clutter" / "Tapestry"), hiding that
# they're really dozens of distinct objects. We split them into grouped items
# keyed by the variant's base name (the `type` with any trailing number stripped,
# e.g. "toy7" -> "toy", "ambush3" -> "ambush", "rotbeast11" -> "rotbeast"), so
# every piece of the same object aggregates under one item (a single median
# price) while each listing still carries its exact variant ("toy7", "ambush3").
#
# A grouped item needs a stable, collision-free numeric id (the whole explorer is
# keyed by numeric itemId). Real item/block ids are small (< ~15k), so we map each
# group into a high range via a stable hash, probing on the rare clash. Groups are
# namespaced by category so a clutter and a tapestry base of the same spelling can
# never merge into one item.
SPLIT_TYPE_CATEGORIES = {"clutter", "tapestry"}
VARIANT_ID_BASE = 90_000_000
_variant_synth_ids: Dict[str, int] = {}
_variant_used_ids: set = set()


def _variant_base(variant: str) -> str:
    """Group key for a type variant: the `type` string with any trailing number
    stripped (e.g. "toy7" -> "toy", "rotbeast11" -> "rotbeast",
    "fence/iron/empty1" -> "fence/iron/empty"). Falls back to the raw variant if
    stripping empties it."""
    base = re.sub(r"\d+$", "", variant).rstrip("-_/")
    return base or variant


def _humanize_variant(base: str) -> str:
    """Readable display name for a variant group (e.g. "pile-cloth" ->
    "Pile cloth", "chains/chain-ceiling-hook" -> "Chains chain ceiling hook")."""
    words = [w for w in re.split(r"[\-_/]+", base) if w]
    text = " ".join(words) if words else base
    return text[:1].upper() + text[1:]


def _variant_synth_id(key: str) -> int:
    """Stable synthetic numeric id for a variant group, well outside the real id
    range and de-duplicated so two groups never share an id. `key` is namespaced
    by category (e.g. "tapestry:ambush")."""
    sid = _variant_synth_ids.get(key)
    if sid is not None:
        return sid
    sid = VARIANT_ID_BASE + (zlib.crc32(key.encode("utf-8")) % 9_000_000)
    while sid in _variant_used_ids:
        sid += 1
    _variant_synth_ids[key] = sid
    _variant_used_ids.add(sid)
    return sid


def type_variant(item: Dict[str, Any], attrs: Optional[Dict[str, Any]]) -> Optional[Tuple[int, str, str]]:
    """If this item is a clutter/tapestry block whose real object lives in
    `attrs.type`, return ``(synthetic_item_id, group_display_name,
    variant_label)``; else ``None``.

    Generic fallbacks that already resolve to their own id (e.g. clutter
    "art/bottle", "skull/humanoid" with no `type` attribute) are left untouched.
    """
    category = item.get("category")
    if category not in SPLIT_TYPE_CATEGORIES or not attrs:
        return None
    variant = attrs.get("type")
    if not isinstance(variant, str) or not variant.strip():
        return None
    variant = variant.strip()
    base = _variant_base(variant)
    return _variant_synth_id(f"{category}:{base}"), _humanize_variant(base), variant


# --------------------------------------------------------------------------- #
# Stats helpers (pure python; no numpy dependency)
# --------------------------------------------------------------------------- #
def percentile(sorted_vals: List[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    idx = q * (len(sorted_vals) - 1)
    lo = math.floor(idx)
    hi = math.ceil(idx)
    if lo == hi:
        return float(sorted_vals[lo])
    frac = idx - lo
    return float(sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac)


def price_stats(prices: List[float]) -> Dict[str, float]:
    s = sorted(prices)
    return {
        "count": len(s),
        "min": s[0] if s else 0,
        "p10": round(percentile(s, 0.10), 2),
        "p25": round(percentile(s, 0.25), 2),
        "median": round(percentile(s, 0.50), 2),
        "p75": round(percentile(s, 0.75), 2),
        "p90": round(percentile(s, 0.90), 2),
        "max": s[-1] if s else 0,
        "mean": round(sum(s) / len(s), 2) if s else 0,
    }


def _has_written_text(rec: Dict[str, Any]) -> bool:
    """Whether a listing carries written content — a parchment/book someone wrote
    a story, note, or advert on (stored in the stack's `text`/`title` attrs).
    Such items are priced for their content, not as the raw commodity, so they're
    excluded from fair-price aggregation while still shown in the listing tables.
    """
    attrs = rec.get("attrs") or {}
    text = attrs.get("text")
    title = attrs.get("title")
    return bool(
        (isinstance(text, str) and text.strip())
        or (isinstance(title, str) and title.strip())
    )


def _sale_time_key(r: Dict[str, Any]) -> str:
    """Best wall-clock timestamp for ordering a sale by recency. ISO-8601
    strings compare correctly lexicographically, so no parsing needed."""
    return r.get("lastObservedUtc") or r.get("observedUtc") or ""


def price_trend(sold_recs: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Flag whether an item's per-unit price is trending up, down, or holding
    steady by comparing the most-recent sales against older ones.

    Uses real-world observation time (not in-game hours) so it reacts to live
    market shifts — e.g. a game update that makes an item rarer and pushes its
    price up. Returns ``None`` when there aren't enough dated sales on both
    sides to make a non-noisy call.
    """
    dated = [r for r in sold_recs if _sale_time_key(r)]
    # Need a reasonable sample so the indicator doesn't flip-flop on 1-2 sales.
    if len(dated) < 8:
        return None
    dated.sort(key=_sale_time_key)
    # Recent window = most-recent third of sales (min 3); older = the rest.
    recent_n = max(3, len(dated) // 3)
    recent = dated[-recent_n:]
    older = dated[:-recent_n]
    if len(older) < 3:
        return None
    recent_med = percentile(sorted(r["pricePerUnit"] for r in recent), 0.50)
    older_med = percentile(sorted(r["pricePerUnit"] for r in older), 0.50)
    if older_med <= 0:
        return None
    change = (recent_med - older_med) / older_med
    # ±8% dead-band so small wobbles read as "steady".
    if change > 0.08:
        direction = "up"
    elif change < -0.08:
        direction = "down"
    else:
        direction = "flat"
    return {
        "direction": direction,
        "changePct": round(change * 100, 1),
        "recentMedian": round(recent_med, 3),
        "olderMedian": round(older_med, 3),
        "recentCount": len(recent),
        "olderCount": len(older),
    }


# --------------------------------------------------------------------------- #
# Deduplication
# --------------------------------------------------------------------------- #
def dedup_latest(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Collapse to one row per AuctionId, keeping the most-recently-observed one.
    Terminal states win ties over Active."""
    best: Dict[int, Dict[str, Any]] = {}
    for row in rows:
        aid = row.get("AuctionId")
        if aid is None:
            continue
        prev = best.get(aid)
        if prev is None:
            best[aid] = row
            continue
        cur_key = (
            row.get("lastObservedUtc") or "",
            1 if row.get("State") in TERMINAL_STATES else 0,
        )
        prev_key = (
            prev.get("lastObservedUtc") or "",
            1 if prev.get("State") in TERMINAL_STATES else 0,
        )
        if cur_key > prev_key:
            best[aid] = row
    return list(best.values())


# --------------------------------------------------------------------------- #
# Spam / outlier heuristic
# --------------------------------------------------------------------------- #
def flag_spam(records: List[Dict[str, Any]]) -> None:
    """Mark listings from sellers that post large volumes at flat, never-selling
    prices (test spam). Mutates each record's `spam` flag."""
    by_seller: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for rec in records:
        if rec.get("sellerUid"):
            by_seller[rec["sellerUid"]].append(rec)

    spammy_sellers = set()
    for uid, recs in by_seller.items():
        if len(recs) < 25:
            continue
        sold = sum(1 for r in recs if r["sold"])
        sell_through = sold / len(recs)
        price_counts = Counter(r["price"] for r in recs)
        top_share = price_counts.most_common(1)[0][1] / len(recs)
        # High volume, almost never sells, dominated by one flat price.
        if sell_through < 0.05 and top_share > 0.5:
            spammy_sellers.add(uid)

    for rec in records:
        rec["spam"] = rec.get("sellerUid") in spammy_sellers


# --------------------------------------------------------------------------- #
# Main transform
# --------------------------------------------------------------------------- #
def build_records(
    rows: List[Dict[str, Any]],
    item_map: Dict[str, Dict[str, str]],
    registry: Dict[str, Dict[str, str]],
) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    records: List[Dict[str, Any]] = []
    items_catalog: Dict[str, Dict[str, Any]] = {}

    for row in rows:
        stack = decode_itemstack(row.get("Item", {}).get("RawHex"))
        if stack is None:
            continue
        item = resolve_item(stack, row.get("Item") or {}, item_map, registry)
        attrs = stack["attributes"] or None

        # Clutter and tapestry are one block id hiding many distinct objects (the
        # real one is in `attrs.type`). Split them into per-object groups so each
        # aggregates separately, while the listing keeps its exact variant label.
        variant = None
        cv = type_variant(item, attrs)
        if cv is not None:
            item["itemId"], item["name"], variant = cv

        items_catalog[str(item["itemId"])] = {
            "name": item["name"],
            "category": item["category"],
            "code": item["code"],
            "classType": item["classType"],
            "maxStackSize": item.get("maxStackSize"),
        }

        price = float(row.get("Price") or 0)
        stack_size = stack["stackSize"]
        state = row.get("State")
        sold = state in SOLD_STATES
        posted = row.get("PostedTotalHours")
        retrievable = row.get("RetrievableTotalHours")
        time_to_sell = None
        if sold and posted and retrievable and retrievable > 0:
            time_to_sell = round(retrievable - posted, 2)

        src = (_to_relative(row.get("SrcX")), _to_relative(row.get("SrcZ")))
        dst = (_to_relative(row.get("DstX")), _to_relative(row.get("DstZ")))
        delivered = bool(row.get("WithDelivery"))
        # Delivery fee the buyer paid (in gears) for delivered listings; 0 for
        # pickup. Present on every row as `DeliveryFeeGears`.
        delivery_fee = round(float(row.get("DeliveryFeeGears") or 0), 2)
        trade_distance = None
        if delivered and dst[0] and dst[1]:
            trade_distance = round(math.hypot(src[0] - dst[0], src[1] - dst[1]), 1)

        records.append(
            {
                "auctionId": row.get("AuctionId"),
                "itemId": item["itemId"],
                "name": item["name"],
                "category": item["category"],
                "classType": item["classType"],
                # Exact clutter object for this listing (e.g. "toy7"); null for
                # non-clutter items and generic clutter without a `type` attr.
                "variant": variant,
                "attrs": attrs,
                "price": price,
                "qty": stack_size,
                "pricePerUnit": round(price / stack_size, 3) if stack_size else price,
                "traderCut": row.get("TraderCut") or 0,
                # Non-refundable deposit the seller paid to list this auction,
                # set by its duration in weeks (independent of sale outcome).
                "depositFee": deposit_fee_for_hours(row.get("InitialDurationHours")),
                "state": state,
                "sold": sold,
                # Whether we ever captured a *terminal* verdict for this auction.
                # False means the listing is only known as "Active" because it
                # stopped being observed before selling/expiring — so its state is
                # a last-known guess, not a confirmed live listing.
                "verdictObserved": state in TERMINAL_STATES,
                "delivered": delivered,
                "deliveryFee": delivery_fee,
                "sellerName": row.get("SellerName"),
                "sellerUid": row.get("SellerUid"),
                "buyerName": row.get("BuyerName"),
                "buyerUid": row.get("BuyerUid"),
                "srcX": round(src[0], 1),
                "srcZ": round(src[1], 1),
                "dstX": round(dst[0], 1),
                "dstZ": round(dst[1], 1),
                "tradeDistance": trade_distance,
                "timeToSellHours": time_to_sell,
                "postedTotalHours": posted,
                "observedUtc": row.get("observedUtc"),
                "lastObservedUtc": row.get("lastObservedUtc"),
            }
        )

    flag_spam(records)
    return records, items_catalog


def build_summary(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    clean = [r for r in records if not r["spam"]]
    sold = [r for r in clean if r["sold"]]

    # --- Per-item stats (fair-price from sold listings only) -------------- #
    by_item: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for r in clean:
        by_item[r["itemId"]].append(r)

    item_stats = []
    for item_id, recs in by_item.items():
        sold_recs = [r for r in recs if r["sold"]]
        expired = sum(1 for r in recs if r["state"] == "Expired")
        # Written parchments/books are priced for their story, not the raw item,
        # so drop them from the fair-price figures (median / percentiles / trend)
        # while still counting them toward sold volume below.
        priced_sold = [r for r in sold_recs if not _has_written_text(r)]
        ppu_sold = [r["pricePerUnit"] for r in priced_sold]
        tts = [r["timeToSellHours"] for r in sold_recs if r["timeToSellHours"] is not None]
        item_stats.append(
            {
                "itemId": item_id,
                "name": recs[0]["name"],
                "category": recs[0]["category"],
                "listings": len(recs),
                "soldCount": len(sold_recs),
                "sellThrough": round(len(sold_recs) / (len(sold_recs) + expired), 3)
                if (len(sold_recs) + expired)
                else None,
                "medianTimeToSell": round(sorted(tts)[len(tts) // 2], 2) if tts else None,
                "unitsSold": sum(r["qty"] for r in sold_recs),
                "gearsTraded": sum(r["price"] for r in sold_recs),
                "priceStats": price_stats(ppu_sold) if ppu_sold else None,
                "trend": price_trend(priced_sold),
            }
        )
    item_stats.sort(key=lambda x: x["gearsTraded"], reverse=True)

    # --- Leaderboards ----------------------------------------------------- #
    sellers: Dict[str, Dict[str, Any]] = defaultdict(
        lambda: {"name": None, "revenue": 0.0, "sold": 0, "listed": 0}
    )
    buyers: Dict[str, Dict[str, Any]] = defaultdict(
        lambda: {"name": None, "spent": 0.0, "bought": 0}
    )
    for r in clean:
        if r["sellerUid"]:
            s = sellers[r["sellerUid"]]
            s["name"] = r["sellerName"]
            s["listed"] += 1
            if r["sold"]:
                s["sold"] += 1
                s["revenue"] += r["price"] - (r["traderCut"] or 0)  # net of fee
        if r["sold"] and r["buyerUid"]:
            b = buyers[r["buyerUid"]]
            b["name"] = r["buyerName"]
            b["bought"] += 1
            b["spent"] += r["price"]

    top_sellers = sorted(
        ({"uid": k, **v} for k, v in sellers.items()),
        key=lambda x: x["revenue"],
        reverse=True,
    )[:50]
    top_buyers = sorted(
        ({"uid": k, **v} for k, v in buyers.items()),
        key=lambda x: x["spent"],
        reverse=True,
    )[:50]
    biggest_sales = sorted(sold, key=lambda r: r["price"], reverse=True)[:50]

    # --- Heatmap bins ----------------------------------------------------- #
    def bin_counts(pairs: List[Tuple[float, float]]) -> List[Dict[str, Any]]:
        grid: Counter = Counter()
        for x, z in pairs:
            if not x and not z:
                continue
            gx = int(x // HEATMAP_BIN) * HEATMAP_BIN
            gz = int(z // HEATMAP_BIN) * HEATMAP_BIN
            grid[(gx, gz)] += 1
        return [{"x": k[0], "z": k[1], "count": v} for k, v in grid.items()]

    sell_bins = bin_counts([(r["srcX"], r["srcZ"]) for r in sold])
    buy_bins = bin_counts(
        [(r["dstX"], r["dstZ"]) for r in sold if r["delivered"] and r["dstX"]]
    )

    # Auctioneer locations clustered by rounded coords (entity ids not stable).
    auctioneers: Counter = Counter()
    for r in clean:
        if r["srcX"] or r["srcZ"]:
            ax = round(r["srcX"] / AUCTIONEER_BIN) * AUCTIONEER_BIN
            az = round(r["srcZ"] / AUCTIONEER_BIN) * AUCTIONEER_BIN
            auctioneers[(ax, az)] += 1
    auctioneer_list = sorted(
        ({"x": k[0], "z": k[1], "listings": v} for k, v in auctioneers.items()),
        key=lambda a: a["listings"],
        reverse=True,
    )[:200]

    # --- Market totals ---------------------------------------------------- #
    total_gears = sum(r["price"] for r in sold)
    delivered_sold = [r for r in sold if r["delivered"]]
    delivery_fees_paid = sum(r.get("deliveryFee") or 0 for r in sold)
    totals = {
        "totalAuctions": len(clean),
        "activeListings": sum(1 for r in clean if r["state"] == "Active"),
        "soldCount": len(sold),
        "expiredCount": sum(1 for r in clean if r["state"] == "Expired"),
        "gearsTraded": round(total_gears, 2),
        "feesPaid": round(sum(r["traderCut"] or 0 for r in sold), 2),
        # Deposit is paid up-front to list, regardless of whether the auction
        # sells or expires, so sum it across every (non-spam) listing.
        "depositFeesPaid": round(sum(r.get("depositFee") or 0 for r in clean), 2),
        # Delivery: total fees buyers paid for delivered sales, how many sales
        # used delivery, and that share of all sales.
        "deliveryFeesPaid": round(delivery_fees_paid, 2),
        "deliveredCount": len(delivered_sold),
        "deliveryRate": round(len(delivered_sold) / len(sold), 3) if sold else 0,
        "uniqueSellers": len(sellers),
        "uniqueBuyers": len(buyers),
        "uniqueItems": len(by_item),
        "sellThrough": round(
            len(sold) / (len(sold) + sum(1 for r in clean if r["state"] == "Expired")), 3
        )
        if sold
        else 0,
        "spamFiltered": sum(1 for r in records if r["spam"]),
    }

    return {
        "generatedUtc": datetime.now(timezone.utc).isoformat(),
        "totals": totals,
        "itemStats": item_stats,
        "topSellers": top_sellers,
        "topBuyers": top_buyers,
        "biggestSales": [
            {
                "auctionId": r["auctionId"],
                "itemId": r["itemId"],
                "name": r["name"],
                "variant": r.get("variant"),
                "price": r["price"],
                "qty": r["qty"],
                "sellerName": r["sellerName"],
                "buyerName": r["buyerName"],
            }
            for r in biggest_sales
        ],
        "sellHeatmap": sell_bins,
        "buyHeatmap": buy_bins,
        "auctioneers": auctioneer_list,
        "heatmapBin": HEATMAP_BIN,
    }


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    size_kb = path.stat().st_size / 1024
    print(f"  wrote {path.relative_to(REPO_ROOT)}  ({size_kb:,.1f} KB)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    ap.add_argument("--item-map", type=Path, default=DEFAULT_ITEM_MAP)
    ap.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUTPUT_DIR)
    args = ap.parse_args()

    print(f"Reading {args.input}…")
    raw_lines = [l for l in args.input.read_text(encoding="utf-8").splitlines() if l.strip()]
    rows = [json.loads(l) for l in raw_lines]
    print(f"  {len(rows):,} raw rows")

    deduped = dedup_latest(rows)
    print(f"  {len(deduped):,} unique auctions after dedup")

    item_map = load_item_map(args.item_map)
    registry = load_registry(args.registry)
    print(
        f"  registry: {len(registry['Item']):,} items, {len(registry['Block']):,} blocks"
    )
    records, items_catalog = build_records(deduped, item_map, registry)
    print(f"  {len(records):,} decoded records, {len(items_catalog):,} distinct items")

    summary = build_summary(records)
    print(f"  spam-filtered {summary['totals']['spamFiltered']:,} listings")

    print("Writing artifacts…")
    write_json(args.out / "listings.json", records)
    write_json(args.out / "summary.json", summary)
    write_json(args.out / "items.json", items_catalog)
    print("Done.")


if __name__ == "__main__":
    main()

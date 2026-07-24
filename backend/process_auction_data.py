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
import bisect
import hashlib
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

# An unsold listing that became retrievable before its natural expiry (its
# posting time plus the chosen listing duration) was pulled early by the seller
# rather than running its full term — treated as a cancellation. A small
# tolerance guards against float/capture-timing noise so a listing that ran
# essentially its whole duration isn't misflagged as cancelled.
CANCEL_TOLERANCE_HOURS = 1

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


def duration_weeks_for_hours(initial_duration_hours: Any) -> Optional[int]:
    """The listing length in whole in-game weeks the seller chose, derived from
    its initial duration. Returns None when the duration is missing/unknown."""
    hours = float(initial_duration_hours or 0)
    if hours <= 0:
        return None
    return round(hours / HOURS_PER_WEEK)


def deposit_fee_for_hours(initial_duration_hours: Any) -> int:
    """Deposit (in gears) the seller paid to list the auction, derived from its
    initial duration. Returns 0 when the duration is missing or doesn't match a
    known listing-length option."""
    weeks = duration_weeks_for_hours(initial_duration_hours)
    if weeks is None:
        return 0
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


# Vintage Story registers Items and Blocks in two *separate* id spaces that both
# start near 0, so the same numeric id routinely names a Block and an Item at
# once (e.g. Block 1600 "Clay oven" vs Item 1600 "…malachite crystalized ore").
# The whole explorer keys everything by a single numeric `itemId`, so we lift
# Block ids into a high, dedicated range to keep them globally unique. Without
# this, one form silently overwrites the other in the item catalog (so it
# vanishes from the Items page) and their two unrelated listings get merged into
# one item's price stats. Must stay above every real id (< ~15k) and below the
# synthetic variant range (`VARIANT_ID_BASE` = 90M) so the three id ranges never
# overlap: real Items 0…~15k, Blocks 20M…~20.015M, variant groups 90M…99M.
BLOCK_ID_OFFSET = 20_000_000


def namespace_item_id(item_id: int, class_type: str) -> int:
    """Globally-unique itemId: Block ids are offset into a dedicated range so
    they never collide with the Item id space (see `BLOCK_ID_OFFSET`)."""
    return item_id + BLOCK_ID_OFFSET if class_type == "Block" else item_id


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
        "itemId": namespace_item_id(item_id, class_type),
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


def weighted_median(pairs: List[Tuple[float, float]]) -> Optional[float]:
    """Quantity-weighted median of (value, weight) pairs — the value at which the
    cumulative weight crosses half the total weight. Used for the "quantity-
    weighted" fair price: each sold listing's per-unit price counts in proportion
    to the quantity it moved, so a single bulk trade outweighs many one-off sales
    while staying robust to outlier prices (unlike a volume-weighted average).
    Returns None when no positive-weight sample exists.
    """
    valid = [(v, w) for v, w in pairs if w > 0]
    if not valid:
        return None
    valid.sort(key=lambda p: p[0])
    total = sum(w for _, w in valid)
    half = total / 2
    cum = 0.0
    for i, (v, w) in enumerate(valid):
        cum += w
        if cum >= half:
            if cum == half and i + 1 < len(valid):
                return (v + valid[i + 1][0]) / 2
            return v
    return valid[-1][0]


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
# Point-in-time market reference price
# --------------------------------------------------------------------------- #
# To judge whether a listing was priced above or below the prevailing market
# (for the player-profile pricing history / fairness charts) we need a
# *point-in-time* reference: the median per-unit price the same item was selling
# for around the moment this listing was posted. It must be time-consistent
# (independent of whatever window a viewer later selects) so it's computed once
# here and stored per listing.
#
# Rules:
#  - Reference is drawn from SOLD, non-spam, non-written-text listings of the
#    same item (mirrors the fair-price exclusions elsewhere).
#  - It EXCLUDES the listing's own seller, so a seller who dominates an item's
#    supply is compared against the rest of the market, not against themselves.
#  - Trailing/leading in-game window around the posting time; falls back to the
#    item-wide sold median (still excluding the own seller) when the local window
#    is too sparse. Null when the market never priced the item from anyone else.

# Half-width of the in-game window (hours) around a listing's posting time from
# which comparable sold prices are drawn. 1440h = ±2 in-game months (720h/month).
REF_WINDOW_HOURS = 1440
# Minimum comparable sold listings required inside the local window before we
# trust it; below this we fall back to the item-wide sold median.
REF_MIN_SAMPLE = 5


def _median(sorted_vals: List[float]) -> Optional[float]:
    n = len(sorted_vals)
    if n == 0:
        return None
    mid = n // 2
    if n % 2:
        return float(sorted_vals[mid])
    return (sorted_vals[mid - 1] + sorted_vals[mid]) / 2


def compute_reference_prices(records: List[Dict[str, Any]]) -> None:
    """Attach `refPricePerUnit`, `refSampleSize` and `pricePremiumPct` to every
    record (mutates in place). See the section header for the methodology.

    Run AFTER `flag_spam` so spam listings are excluded from the reference pool.
    """
    # Build the comparable-sold pool per item, sorted by posting time so a
    # window slice is a contiguous range we can locate with bisect.
    by_item: Dict[int, List[Tuple[float, float, Optional[str]]]] = defaultdict(list)
    for rec in records:
        if (
            not rec["sold"]
            or rec["spam"]
            or _has_written_text(rec)
            or rec.get("postedTotalHours") is None
        ):
            continue
        ppu = rec["pricePerUnit"]
        if ppu is None or ppu <= 0:
            continue
        by_item[rec["itemId"]].append((rec["postedTotalHours"], ppu, rec["sellerUid"]))

    for arr in by_item.values():
        arr.sort(key=lambda t: t[0])
    # Parallel arrays of just the posting times for bisect lookups.
    times_by_item = {iid: [t for t, _, _ in arr] for iid, arr in by_item.items()}

    for rec in records:
        rec["refPricePerUnit"] = None
        rec["refSampleSize"] = 0
        rec["pricePremiumPct"] = None

        posted = rec.get("postedTotalHours")
        ppu = rec["pricePerUnit"]
        if posted is None or ppu is None or ppu <= 0:
            continue
        pool = by_item.get(rec["itemId"])
        if not pool:
            continue
        own = rec["sellerUid"]

        times = times_by_item[rec["itemId"]]
        lo = bisect.bisect_left(times, posted - REF_WINDOW_HOURS)
        hi = bisect.bisect_right(times, posted + REF_WINDOW_HOURS)
        local = [p for _, p, uid in pool[lo:hi] if uid != own]

        if len(local) >= REF_MIN_SAMPLE:
            sample = local
        else:
            # Fall back to the whole item's sold history (still excluding the
            # own seller) so sparsely-traded items still get a reference.
            sample = [p for _, p, uid in pool if uid != own]
        if not sample:
            continue

        ref = _median(sorted(sample))
        if ref is None or ref <= 0:
            continue
        rec["refPricePerUnit"] = round(ref, 3)
        rec["refSampleSize"] = len(sample)
        rec["pricePremiumPct"] = round((ppu - ref) / ref * 100, 1)


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

        # Seller cancellation: an unsold listing that became retrievable before
        # its natural expiry (posting time + chosen listing duration) was pulled
        # early rather than running its full, weeks-long term. Needs a known
        # duration to place the expiry; the tolerance ignores listings that ran
        # essentially their whole term.
        duration_hours = float(row.get("InitialDurationHours") or 0)
        cancelled = bool(
            not sold
            and posted is not None
            and retrievable is not None
            and retrievable > 0
            and duration_hours > 0
            and (retrievable - posted) < (duration_hours - CANCEL_TOLERANCE_HOURS)
        )

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
                # How many in-game weeks the seller chose to list the auction
                # for (drives the deposit above). None when the duration is
                # unknown.
                "durationWeeks": duration_weeks_for_hours(
                    row.get("InitialDurationHours")
                ),
                "state": state,
                "sold": sold,
                # An unsold listing the seller pulled early (retrievable before
                # its natural expiry) rather than a natural expiry.
                "cancelled": cancelled,
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
    compute_reference_prices(records)
    return records, items_catalog


# In-game calendar: 24 hours per day, 30 days per month. The auction time
# series is bucketed by the month (since world start) in which each auction was
# posted, giving ~100 points across this world's history — a clean "market
# activity over time" curve. Each auction (and its eventual outcome) is
# attributed to its posting month.
GAME_HOURS_PER_DAY = 24
GAME_DAYS_PER_MONTH = 30
TIME_SERIES_BUCKET_HOURS = GAME_HOURS_PER_DAY * GAME_DAYS_PER_MONTH  # 720

# The capture begins with a one-off backlog dump of every auction currently on
# the board (posted at all sorts of past in-game times), after which only newly
# posted auctions stream in live. To mark "when recording started" on the
# in-game timeline we take the newest auction posting time seen during that
# initial dump window — i.e. the game clock at the moment capture began.
RECORDING_START_WINDOW_MINUTES = 60


def _parse_observed(ts: Optional[str]) -> Optional[datetime]:
    """Parse an ISO-8601 `observedUtc` timestamp (7-digit fractional seconds
    with a trailing ``Z``) into an aware datetime, or None when unparseable."""
    if not ts:
        return None
    s = ts.strip().replace("Z", "+00:00")
    # .NET writes 100-ns precision (7 fractional digits); trim to microseconds
    # so it round-trips through datetime.fromisoformat on all Python versions.
    m = re.match(r"^(.*\.\d{6})\d*(\+\d{2}:\d{2})$", s)
    if m:
        s = m.group(1) + m.group(2)
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def recording_start_game_hours(clean: List[Dict[str, Any]]) -> Optional[float]:
    """Estimate the in-game clock (total hours) at the moment capture began.

    The earliest `observedUtc` is when recording started; during the first
    ``RECORDING_START_WINDOW_MINUTES`` the whole existing auction board was
    dumped. The newest posting time seen in that window is the game clock then,
    which the frontend draws as a "Started recording" marker on the trend
    chart. Returns None if there aren't enough dated observations.
    """
    dated = [
        (obs, r.get("postedTotalHours") or 0)
        for r in clean
        if (obs := _parse_observed(r.get("observedUtc"))) is not None
        and (r.get("postedTotalHours") or 0) > 0
    ]
    if not dated:
        return None
    t0 = min(obs for obs, _ in dated)
    cutoff = t0.timestamp() + RECORDING_START_WINDOW_MINUTES * 60
    in_window = [ph for obs, ph in dated if obs.timestamp() <= cutoff]
    if not in_window:
        return None
    return round(max(in_window), 2)


# The gap between two Auction House scans is far larger than the spread of
# observation timestamps within a single scan, so any two observations closer
# together than this are treated as belonging to the same scan session.
SCAN_SESSION_GAP_MINUTES = 5


def _last_scan_session_start(records: List[Dict[str, Any]]) -> str:
    """Return the ``lastObservedUtc`` marking the start of the most recent scan
    session, as an ISO-8601 string suitable for lexicographic comparison.

    A scan streams the whole board over up to a minute, so its observations
    carry slightly different timestamps, while consecutive scans are ~30–60 min
    apart. Walking back from the newest observation, every timestamp within
    ``SCAN_SESSION_GAP_MINUTES`` of the previous one belongs to the same final
    session; the earliest such timestamp is its start. Returns ``""`` when there
    are no dated observations (so every non-terminal listing counts).
    """
    stamps = sorted(
        {r.get("lastObservedUtc") for r in records if r.get("lastObservedUtc")}
    )
    parsed = [(s, _parse_observed(s)) for s in stamps]
    parsed = [(s, dt) for s, dt in parsed if dt is not None]
    if not parsed:
        return ""
    start = parsed[-1][0]
    for i in range(len(parsed) - 1, 0, -1):
        gap = (parsed[i][1] - parsed[i - 1][1]).total_seconds() / 60
        if gap <= SCAN_SESSION_GAP_MINUTES:
            start = parsed[i - 1][0]
        else:
            break
    return start


def build_time_series(
    clean: List[Dict[str, Any]], records: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """Aggregate (non-spam) auctions into monthly in-game buckets keyed by
    posting time, so the frontend can chart how market activity evolved.

    Buckets are keyed by ``monthIndex = floor(postedTotalHours / 720)``.
    Every metric is attributed to the auction's posting month, including its
    sale outcome, so per-bucket cumulative sums line up with the market totals.
    Auctions without a known posting time are skipped.

    ``missing`` counts auctions we never captured: auction ids are assigned
    sequentially and (verified) strictly increase with posting time, so every
    gap between two consecutive captured ids is a run of auctions that were
    posted and resolved between our scans. Each gap is attributed to the month
    of the captured auction that follows it. ``records`` (all captured rows,
    including spam) is the "present" set for this — spam auctions were still
    captured, so they are not missing.
    """
    buckets: Dict[int, Dict[str, Any]] = {}
    sellers_by_bucket: Dict[int, set] = defaultdict(set)
    buyers_by_bucket: Dict[int, set] = defaultdict(set)
    items_by_bucket: Dict[int, set] = defaultdict(set)

    # Start of the most recent Auction House scan. A scan isn't instantaneous —
    # it streams over up to a minute, so listings in the same scan get slightly
    # different `lastObservedUtc` values — while scans themselves are ~30–60 min
    # apart. A non-terminal listing last seen in this final scan is simply still
    # live, so it must NOT count as "unrecorded". Only listings that dropped off
    # the board in an earlier scan are genuinely a missed outcome.
    last_scan_start = _last_scan_session_start(records)

    def ensure_bucket(month: int) -> Dict[str, Any]:
        b = buckets.get(month)
        if b is None:
            b = buckets[month] = {
                "monthIndex": month,
                "gameHours": month * TIME_SERIES_BUCKET_HOURS,
                "posted": 0,
                "sold": 0,
                "expired": 0,
                "unitsSold": 0,
                "gearsTraded": 0.0,
                "feesPaid": 0.0,
                "depositFeesPaid": 0.0,
                "deliveryFeesPaid": 0.0,
                "deliveredCount": 0,
                "missing": 0,
                "unrecorded": 0,
            }
        return b

    for r in clean:
        posted = r.get("postedTotalHours")
        if not posted or posted <= 0:
            continue
        month = int(posted // TIME_SERIES_BUCKET_HOURS)
        b = ensure_bucket(month)
        b["posted"] += 1
        b["depositFeesPaid"] += r.get("depositFee") or 0
        items_by_bucket[month].add(r["itemId"])
        if r.get("sellerUid"):
            sellers_by_bucket[month].add(r["sellerUid"])
        # Auctions we only ever saw as "Active" — capture stopped before a
        # terminal verdict, so we never learned whether they sold or expired.
        # Exclude listings seen in the final scan session: those are simply
        # still live, not a missed outcome. A missing timestamp sorts as a
        # far-future sentinel so it's treated as "still current" (never counted).
        if (
            not r.get("verdictObserved")
            and (r.get("lastObservedUtc") or "9999-12-31T23:59:59Z") < last_scan_start
        ):
            b["unrecorded"] += 1
        if r["state"] == "Expired":
            b["expired"] += 1
        if r["sold"]:
            b["sold"] += 1
            b["unitsSold"] += r["qty"]
            b["gearsTraded"] += r["price"]
            b["feesPaid"] += r["traderCut"] or 0
            if r.get("buyerUid"):
                buyers_by_bucket[month].add(r["buyerUid"])
            if r["delivered"]:
                b["deliveredCount"] += 1
                b["deliveryFeesPaid"] += r.get("deliveryFee") or 0

    # Missing auctions from sequential-id gaps, attributed by posting month.
    present = sorted(
        (
            (r["auctionId"], r.get("postedTotalHours") or 0)
            for r in records
            if r.get("auctionId") is not None and (r.get("postedTotalHours") or 0) > 0
        ),
        key=lambda t: t[0],
    )
    prev_id: Optional[int] = None
    for aid, posted in present:
        if prev_id is not None and aid > prev_id + 1:
            month = int(posted // TIME_SERIES_BUCKET_HOURS)
            ensure_bucket(month)["missing"] += aid - prev_id - 1
        prev_id = aid

    series = []
    for month in sorted(buckets):
        b = buckets[month]
        resolved = b["sold"] + b["expired"]
        series.append(
            {
                **b,
                "gearsTraded": round(b["gearsTraded"], 2),
                "feesPaid": round(b["feesPaid"], 2),
                "depositFeesPaid": round(b["depositFeesPaid"], 2),
                "deliveryFeesPaid": round(b["deliveryFeesPaid"], 2),
                "sellThrough": round(b["sold"] / resolved, 3) if resolved else None,
                "uniqueSellers": len(sellers_by_bucket[month]),
                "uniqueBuyers": len(buyers_by_bucket[month]),
                "uniqueItems": len(items_by_bucket[month]),
            }
        )
    return series


# A player's wealth is their net seller revenue plus buyer spend, so both sides
# of the market count. Rather than baking a fixed "elite" cutoff into the data,
# we ship the full ranked wealth distribution plus compact, cutoff-independent
# trade-flow arrays, so the frontend can let the viewer choose how the "elite"
# are defined (top N% of players, or everyone worth at least X gears) and
# recompute the whole breakdown live.


def _gini(values: List[float]) -> Optional[float]:
    """Gini coefficient (0 = perfectly equal, →1 = one player holds it all) over
    positive wealth values. None when there's nothing to measure."""
    vals = sorted(v for v in values if v > 0)
    n = len(vals)
    if n == 0:
        return None
    total = sum(vals)
    if total <= 0:
        return None
    cum = sum(i * v for i, v in enumerate(vals, start=1))
    return round((2 * cum) / (n * total) - (n + 1) / n, 3)


def build_wealth_concentration(
    sold: List[Dict[str, Any]],
    sellers: Dict[str, Dict[str, Any]],
    buyers: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """Summarise how concentrated the market is and how much value flows between
    the wealthiest players.

    Wealth per player = net seller revenue + buyer spend. Instead of committing
    to a single "elite" cutoff, we emit the full ranked wealth distribution and
    two compact, cutoff-independent flow arrays. The frontend can then define the
    elite however it likes — the top ``k`` players (a percentile) or everyone
    worth at least ``X`` gears (an absolute threshold, stable as the server
    population grows) — and recover the trade-flow breakdown for that cutoff.

    For each sold auction with a distinct known seller and buyer we bin its gears
    by the *richer* party's rank (``saleGearsByMaxRank``) and the *poorer*
    party's rank (``saleGearsByMinRank``), where rank 0 is the richest trader.
    Given any elite cutoff of the top ``k`` traders, the client recovers:

        elite ↔ elite       = sum(saleGearsByMaxRank[:k])   (both ranks < k)
        rest  ↔ rest        = sum(saleGearsByMinRank[k:])   (both ranks >= k)
        elite ↔ everyone     = matchedGears − the two above

    Self-trades (same player on both sides) and sales with an unknown party are
    counted in ``unmatchedGears`` and excluded from the flows.
    """
    wealth: Dict[str, float] = defaultdict(float)
    for uid, s in sellers.items():
        wealth[uid] += s["revenue"]
    for uid, b in buyers.items():
        wealth[uid] += b["spent"]

    # Rank every trader by wealth, richest first (rank 0 = the richest).
    order = sorted(wealth.items(), key=lambda kv: kv[1], reverse=True)
    n = len(order)
    total_wealth = sum(w for _, w in order)
    rank_by_uid: Dict[str, int] = {uid: i for i, (uid, _) in enumerate(order)}

    # Display name pulled from whichever side of the market we last saw them on.
    def display_name(uid: str) -> Optional[str]:
        return (sellers.get(uid, {}).get("name")) or (buyers.get(uid, {}).get("name"))

    # Full roster, richest first — powers the elite list and every derived count
    # for whatever cutoff the viewer picks.
    players = [
        {"uid": uid, "name": display_name(uid), "wealth": round(w, 2)}
        for uid, w in order
    ]

    # Cutoff-independent flow bins (see the docstring). Length == trader count.
    by_max_rank = [0.0] * n
    by_min_rank = [0.0] * n
    matched_gears = 0.0
    unmatched_gears = 0.0
    for r in sold:
        su, bu = r.get("sellerUid"), r.get("buyerUid")
        if (
            not su
            or not bu
            or su == bu
            or su not in rank_by_uid
            or bu not in rank_by_uid
        ):
            unmatched_gears += r["price"]
            continue
        rs, rb = rank_by_uid[su], rank_by_uid[bu]
        by_max_rank[max(rs, rb)] += r["price"]
        by_min_rank[min(rs, rb)] += r["price"]
        matched_gears += r["price"]

    return {
        "traderCount": n,
        "totalWealth": round(total_wealth, 2),
        "gini": _gini([w for _, w in order]),
        "matchedGears": round(matched_gears, 2),
        "unmatchedGears": round(unmatched_gears, 2),
        "players": players,
        "saleGearsByMaxRank": [round(x, 2) for x in by_max_rank],
        "saleGearsByMinRank": [round(x, 2) for x in by_min_rank],
    }


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
        weighted_ppu = weighted_median(
            [(r["pricePerUnit"], r["qty"]) for r in priced_sold]
        )
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
                "weightedPricePerUnit": round(weighted_ppu, 2)
                if weighted_ppu is not None
                else None,
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

    # --- Wealth concentration & rich-to-rich trade flows ------------------ #
    wealth = build_wealth_concentration(sold, sellers, buyers)

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

    # --- Time series (bucketed by in-game posting month) ------------------ #
    time_series = build_time_series(clean, records)

    return {
        "generatedUtc": datetime.now(timezone.utc).isoformat(),
        "totals": totals,
        "timeSeries": time_series,
        "timeSeriesBucketHours": TIME_SERIES_BUCKET_HOURS,
        "recordingStartGameHours": recording_start_game_hours(clean),
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
        "wealth": wealth,
    }


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    size_kb = path.stat().st_size / 1024
    try:
        shown = path.relative_to(REPO_ROOT)
    except ValueError:
        # Output dir may live outside the repo (e.g. the proxy's local scratch
        # dir when publishing R2-only). Fall back to the absolute path.
        shown = path
    print(f"  wrote {shown}  ({size_kb:,.1f} KB)")


def _content_version(paths: List[Path]) -> str:
    """Short content hash over the given files. Stable across runs when the
    underlying data is unchanged, so republishing identical data keeps the
    frontend's ``?v=`` cache-buster (and therefore the CDN cache) stable."""
    h = hashlib.sha256()
    for p in sorted(paths, key=lambda x: x.name):
        if p.is_file():
            h.update(p.name.encode("utf-8"))
            h.update(p.read_bytes())
    return h.hexdigest()[:12]


def write_manifest(out_dir: Path, files: List[Path]) -> Path:
    """Write ``manifest.json`` — the invalidation pointer the frontend reads to
    discover the current dataset ``version`` and bust its cache with ``?v=``."""
    existing = [p for p in files if p.is_file()]
    manifest = {
        "version": _content_version(existing),
        "generatedUtc": datetime.now(timezone.utc).isoformat(),
        "files": sorted(p.name for p in existing),
    }
    path = out_dir / "manifest.json"
    write_json(path, manifest)
    return path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    ap.add_argument("--item-map", type=Path, default=DEFAULT_ITEM_MAP)
    ap.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUTPUT_DIR)
    ap.add_argument(
        "--publish-r2",
        action="store_true",
        help="After writing the artifacts, upload them (plus the raw capture, "
        "CSV and manifest) to both the dev and prod public R2 buckets.",
    )
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
    listings_path = args.out / "listings.json"
    summary_path = args.out / "summary.json"
    items_path = args.out / "items.json"
    write_json(listings_path, records)
    write_json(summary_path, summary)
    write_json(items_path, items_catalog)

    # The raw capture and the CSV snapshot live next to the input JSONL (the C#
    # auto-publisher copies both there). Include them so the download button and
    # any raw consumers can pull them straight from R2.
    events_path = args.input
    csv_path = args.input.parent / "auctions.csv"

    # The manifest fingerprints the computed data (what the explorer renders);
    # the raw capture/CSV are the same underlying data, so they don't affect it.
    manifest_path = write_manifest(args.out, [listings_path, summary_path, items_path])

    if args.publish_r2:
        print("Publishing to R2 (dev + prod)…")
        import sys

        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from auction_r2_publish import publish_auction_files

        publish_auction_files(
            [
                listings_path,
                summary_path,
                items_path,
                events_path,
                csv_path,
                manifest_path,
            ]
        )

    print("Done.")


if __name__ == "__main__":
    main()

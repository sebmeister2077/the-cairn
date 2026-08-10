"""N-way lattice merge of collapsed auction-events records.

Generalises ``vintagestory-midm/tools/merge-auction-events.py`` (a 2-file merge)
to any number of sources, and makes the result order-independent so contributions
from different machines fold together deterministically regardless of arrival
order. Each source is an iterable of already-collapsed records (one dict per
``AuctionId``), e.g. the parsed lines of a contributor's ``auction-events.jsonl``.

Per ``AuctionId`` the join is a lattice:
* ``observedUtc``     = min (earliest anyone first saw it)
* ``lastObservedUtc`` = max (latest anyone last saw it)
* state / mutable fields = the record with the highest ``(is_terminal,
  lastObservedUtc)`` key — i.e. the most-advanced terminal state, else the most
  recent observation (mirrors ``process_auction_data.dedup_latest``)
* immutable listing fields = first non-null seen (kept, never overwritten with null)
* ``Bought`` / ``VerdictObserved`` = sticky OR across all sources

Re-submitting the same file is a no-op (idempotent); merging the same sources in
any order yields the same output.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Iterator, List, Optional

# Field order the exporter writes, so merged output matches the raw file shape.
FIELD_ORDER = [
    "observedUtc", "lastObservedUtc", "AuctionId", "Price", "TraderCut", "State",
    "Bought", "VerdictObserved", "PostedTotalHours", "ExpireTotalHours",
    "RetrievableTotalHours", "InitialDurationHours", "MoneyCollected",
    "WithDelivery", "DeliveryDistance", "DeliveryFeeGears", "SellerName",
    "SellerUid", "SellerEntityId", "BuyerName", "BuyerUid", "SrcX", "SrcY", "SrcZ",
    "SrcAuctioneerEntityId", "DstX", "DstY", "DstZ", "DstAuctioneerEntityId", "Item",
]

# Intrinsic listing fields — set once when the auction is posted and never change
# for the life of the auction. Coalesced (first non-null) so a later terminal
# observation that omits them doesn't wipe them. Buyer/State/MoneyCollected are
# deliberately NOT here: those are supplied by the winning (advanced) record.
_IMMUTABLE_FIELDS = [
    "Price", "TraderCut", "PostedTotalHours", "ExpireTotalHours",
    "RetrievableTotalHours", "InitialDurationHours", "WithDelivery",
    "DeliveryDistance", "DeliveryFeeGears", "SellerName", "SellerUid",
    "SellerEntityId", "SrcX", "SrcY", "SrcZ", "SrcAuctioneerEntityId",
    "DstX", "DstY", "DstZ", "DstAuctioneerEntityId", "Item",
]

_TERMINAL_STATES = {"Sold", "SoldRetrieved", "Expired"}
_MIN_DT = datetime.min.replace(tzinfo=timezone.utc)


def parse_ts(s: Optional[str]) -> Optional[datetime]:
    """Parse a .NET round-trip ("O") timestamp, trimming 7-digit fractions."""
    if not s:
        return None
    t = s
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    if "." in t:
        head, frac = t.split(".", 1)
        if "+" in frac:
            digits, tz = frac.split("+", 1)
            tz = "+" + tz
        elif "-" in frac[1:]:
            idx = frac.index("-", 1)
            digits, tz = frac[:idx], frac[idx:]
        else:
            digits, tz = frac, ""
        digits = digits[:6]
        t = f"{head}.{digits}{tz}"
    try:
        return datetime.fromisoformat(t)
    except ValueError:
        return None


def _empty(v: Any) -> bool:
    return v is None or v == ""


def _min_ts(a: Optional[str], b: Optional[str]) -> Optional[str]:
    da, db = parse_ts(a), parse_ts(b)
    if da and db:
        return a if da <= db else b
    return a or b


def _max_ts(a: Optional[str], b: Optional[str]) -> Optional[str]:
    da, db = parse_ts(a), parse_ts(b)
    if da and db:
        return a if da >= db else b
    return b or a


def _winner_key(r: Dict[str, Any]):
    is_terminal = 1 if r.get("State") in _TERMINAL_STATES else 0
    dt = parse_ts(r.get("lastObservedUtc")) or _MIN_DT
    return (is_terminal, dt)


def _combine(a: Dict[str, Any], b: Dict[str, Any]) -> Dict[str, Any]:
    winner, loser = (b, a) if _winner_key(b) >= _winner_key(a) else (a, b)
    m = dict(winner)
    m["observedUtc"] = _min_ts(a.get("observedUtc"), b.get("observedUtc"))
    m["lastObservedUtc"] = _max_ts(a.get("lastObservedUtc"), b.get("lastObservedUtc"))
    bought = bool(a.get("Bought")) or bool(b.get("Bought"))
    m["Bought"] = bought
    m["VerdictObserved"] = (
        bool(a.get("VerdictObserved")) or bool(b.get("VerdictObserved")) or bought
    )
    # Backfill intrinsic listing fields only from a real (non-empty) loser value
    # when the winner's is missing/empty. Never invent null keys.
    for k in _IMMUTABLE_FIELDS:
        if _empty(m.get(k)) and not _empty(loser.get(k)):
            m[k] = loser[k]
    return m


def _normalize(row: Dict[str, Any]) -> Dict[str, Any]:
    """Coerce a single-source record so its output matches a merged one."""
    m = dict(row)
    bought = bool(m.get("Bought"))
    m["Bought"] = bought
    m["VerdictObserved"] = bool(m.get("VerdictObserved")) or bought
    return m


def _ordered(o: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k in FIELD_ORDER:
        if k in o:
            out[k] = o[k]
    for k in o:  # preserve any extra fields at the end
        if k not in out:
            out[k] = o[k]
    return out


def merge_events(sources: Iterable[Iterable[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Fold all sources into one collapsed list, one record per AuctionId."""
    merged: Dict[Any, Dict[str, Any]] = {}
    for src in sources:
        for row in src:
            aid = row.get("AuctionId")
            if aid is None:
                continue
            cur = merged.get(aid)
            merged[aid] = _normalize(row) if cur is None else _combine(cur, row)
    return [_ordered(v) for v in merged.values()]


def iter_json_lines(lines: Iterable[str]) -> Iterator[Dict[str, Any]]:
    """Parse JSONL text lines into dicts, skipping blanks/malformed."""
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue

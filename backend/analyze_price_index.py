#!/usr/bin/env python3
"""Feasibility prototype for an Auction House inflation index (a Consumer Price
Index for the TOPS server, priced in Rusty Gears).

This is a STANDALONE analysis tool — it is NOT wired into the publish pipeline.
Its job is to answer two questions before we build any UI:
  1. Can a defensible aggregate inflation index be computed from the sold-auction
     capture?
  2. What confidence would it have?

Run:
    python backend/analyze_price_index.py
    python backend/analyze_price_index.py --bin week --min-sales 3 --bootstrap 1000

Method (why it survives sticky prices)
--------------------------------------
Per-item inflation is unreliable: many sellers never adjust prices and thin
items are noisy. So we never trust one item. Instead we build a *matched-model,
expenditure-weighted chained price index* — the same family real statistical
agencies use:

  * Bin sold listings into real-world time buckets (default: weekly, by
    `lastObservedUtc`, the moment we confirmed the sale).
  * Per (bucket, item) take the MEDIAN price-per-unit and the total gears traded.
  * Between consecutive buckets, for every item that traded in BOTH, form a price
    relative r_i = median_now / median_prev. Sticky items give r_i ≈ 1 (correct —
    those goods genuinely didn't inflate), so they dampen rather than break it.
  * Aggregate the relatives three ways for cross-check:
      - Jevons     : unweighted geometric mean (every item equal).
      - Törnqvist  : gears-share-weighted geometric mean  <- HEADLINE.
      - Weighted median : Cleveland-Fed-style robust centre.
  * Chain the per-step factors to a base of 100 at the window start.

Confidence
----------
  * Bootstrap CI: resample the basket of item relatives (with replacement) B times
    per step, re-chain, and take 2.5/97.5 percentiles -> a band on every point and
    on the headline 3-month figure.
  * Diagnostics: basket size per step, share of total gears covered by the matched
    basket, and cross-item dispersion. A qualitative confidence grade is derived
    from CI width + basket size + coverage.

Nothing here is written to disk; it prints a report.
"""

# NOTE: the SHIPPING index lives in process_auction_data.build_price_index (emitted
# into summary.json). This script is the exploratory tool used to choose and sanity-
# check that methodology; the two intentionally share the same math.

from __future__ import annotations

import argparse
import json
import math
import random
import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from process_auction_data import (
    DEFAULT_INPUT,
    DEFAULT_ITEM_MAP,
    DEFAULT_REGISTRY,
    _has_written_text,
    _parse_utc,
    build_records,
    dedup_latest,
    load_item_map,
    load_registry,
    percentile,
)

# --------------------------------------------------------------------------- #
# Binning
# --------------------------------------------------------------------------- #
BIN_SECONDS = {
    "day": 86400,
    "week": 7 * 86400,
    "biweek": 14 * 86400,
    "month": 30 * 86400,  # real-world 30-day bucket (NOT the in-game calendar)
}


def sale_timestamp(rec: Dict[str, Any]) -> Optional[datetime]:
    """Best real-world timestamp for when a sale was confirmed. `lastObservedUtc`
    is when we last saw the (now Sold) listing; for sales witnessed live during
    recording it is within one scan of the true sale time."""
    return _parse_utc(rec.get("lastObservedUtc")) or _parse_utc(rec.get("observedUtc"))


def clean_sold(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Sold listings usable for price statistics: exclude spam, external/barter
    trades, and written parchments/books (priced for their story, not the good).
    Require a positive per-unit price, quantity, and a real sale timestamp."""
    out = []
    for r in records:
        if not r.get("sold") or r.get("spam") or r.get("externalTrade"):
            continue
        if _has_written_text(r):
            continue
        ppu = r.get("pricePerUnit")
        if not ppu or ppu <= 0 or not r.get("qty"):
            continue
        if sale_timestamp(r) is None:
            continue
        out.append(r)
    return out


def assign_bins(
    recs: List[Dict[str, Any]], bin_name: str
) -> Tuple[List[Tuple[int, Dict[str, Any]]], datetime]:
    """Tag each record with an integer bin index counted from the earliest sale."""
    width = BIN_SECONDS[bin_name]
    t0 = min(sale_timestamp(r) for r in recs)
    tagged = []
    for r in recs:
        ts = sale_timestamp(r)
        idx = int((ts - t0).total_seconds() // width)
        tagged.append((idx, r))
    return tagged, t0


# --------------------------------------------------------------------------- #
# Per-(bin, item) aggregation
# --------------------------------------------------------------------------- #
class Cell:
    __slots__ = ("prices", "gears", "count")

    def __init__(self) -> None:
        self.prices: List[float] = []
        self.gears: float = 0.0
        self.count: int = 0

    def add(self, ppu: float, price: float) -> None:
        self.prices.append(ppu)
        self.gears += price
        self.count += 1

    @property
    def median(self) -> float:
        return statistics.median(self.prices)


def build_cells(
    tagged: List[Tuple[int, Dict[str, Any]]]
) -> Dict[int, Dict[int, Cell]]:
    """bin index -> itemId -> Cell (median price-per-unit + gears + count)."""
    cells: Dict[int, Dict[int, Cell]] = defaultdict(lambda: defaultdict(Cell))
    for idx, r in tagged:
        cells[idx][r["itemId"]].add(r["pricePerUnit"], r["price"])
    return cells


# --------------------------------------------------------------------------- #
# Index steps
# --------------------------------------------------------------------------- #
class Relative:
    """One item's price relative between two adjacent bins, with the gears it
    traded in each bin (for expenditure weighting)."""

    __slots__ = ("item_id", "log_r", "gears_prev", "gears_now")

    def __init__(self, item_id: int, log_r: float, gears_prev: float, gears_now: float):
        self.item_id = item_id
        self.log_r = log_r
        self.gears_prev = gears_prev
        self.gears_now = gears_now


def step_relatives(
    prev: Dict[int, Cell], now: Dict[int, Cell], min_sales: int
) -> List[Relative]:
    """Matched-model relatives: items that traded >= min_sales times in BOTH bins."""
    rels = []
    for item_id, c_now in now.items():
        c_prev = prev.get(item_id)
        if c_prev is None:
            continue
        if c_prev.count < min_sales or c_now.count < min_sales:
            continue
        m_prev, m_now = c_prev.median, c_now.median
        if m_prev <= 0 or m_now <= 0:
            continue
        rels.append(Relative(item_id, math.log(m_now / m_prev), c_prev.gears, c_now.gears))
    return rels


def tornqvist_weights(rels: List[Relative]) -> List[float]:
    """Törnqvist weight per item = mean of its gears-share across the two bins."""
    tot_prev = sum(r.gears_prev for r in rels) or 1.0
    tot_now = sum(r.gears_now for r in rels) or 1.0
    return [0.5 * (r.gears_prev / tot_prev + r.gears_now / tot_now) for r in rels]


def weighted_mean(values: List[float], weights: List[float]) -> float:
    w = sum(weights) or 1.0
    return sum(v * wi for v, wi in zip(values, weights)) / w


def weighted_median(values: List[float], weights: List[float]) -> float:
    pairs = sorted(zip(values, weights))
    total = sum(weights)
    if total <= 0:
        return 0.0
    half, cum = total / 2, 0.0
    for v, wi in pairs:
        cum += wi
        if cum >= half:
            return v
    return pairs[-1][0]


def weighted_trimmed_mean(
    values: List[float], weights: List[float], trim: float = 0.16
) -> float:
    """Expenditure-weighted mean after discarding `trim` of the weight from each
    tail (Cleveland-Fed trimmed-CPI style). Smoother than the median yet still
    robust to a few volatile big-ticket items. Boundary weights are split
    fractionally so the trim is exact."""
    pairs = sorted(zip(values, weights))
    total = sum(weights)
    if total <= 0:
        return 0.0
    lo_cut, hi_cut = total * trim, total * (1 - trim)
    cum = num = wsum = 0.0
    for v, w in pairs:
        seg_lo, seg_hi = max(cum, lo_cut), min(cum + w, hi_cut)
        cum += w
        if seg_hi > seg_lo:
            num += v * (seg_hi - seg_lo)
            wsum += seg_hi - seg_lo
    return num / wsum if wsum > 0 else weighted_median(values, weights)


def step_factors(rels: List[Relative]) -> Dict[str, float]:
    """The aggregate step factors (multiplicative) for one bin transition."""
    if not rels:
        return {"trimmed": 1.0, "tornqvist": 1.0, "jevons": 1.0, "median": 1.0}
    logs = [r.log_r for r in rels]
    w = tornqvist_weights(rels)
    return {
        "trimmed": math.exp(weighted_trimmed_mean(logs, w)),
        "tornqvist": math.exp(weighted_mean(logs, w)),
        "jevons": math.exp(sum(logs) / len(logs)),
        "median": math.exp(weighted_median(logs, w)),
    }


def chain(steps: List[Dict[str, float]], method: str, base: float = 100.0) -> List[float]:
    idx = [base]
    for s in steps:
        idx.append(idx[-1] * s[method])
    return idx


# --------------------------------------------------------------------------- #
# Bootstrap confidence
# --------------------------------------------------------------------------- #
def bootstrap_ci(
    step_rels: List[List[Relative]],
    method: str,
    iterations: int,
    seed: int = 12345,
) -> List[Tuple[float, float]]:
    """Per-point 95% CI for the chained index by resampling each step's basket of
    item relatives with replacement. Returns [(lo, hi)] aligned to the index path
    (including the fixed base point)."""
    rng = random.Random(seed)
    n_points = len(step_rels) + 1
    paths: List[List[float]] = [[] for _ in range(n_points)]
    for _ in range(iterations):
        val = 100.0
        paths[0].append(val)
        for i, rels in enumerate(step_rels, start=1):
            if rels:
                sample = [rels[rng.randrange(len(rels))] for _ in range(len(rels))]
                val *= step_factors(sample)[method]
            paths[i].append(val)
    return [
        (percentile(sorted(p), 0.025), percentile(sorted(p), 0.975)) if p else (0.0, 0.0)
        for p in paths
    ]


# --------------------------------------------------------------------------- #
# Two-window headline (drift-free) + category breakdown
# --------------------------------------------------------------------------- #
def window_cells(
    recs: List[Dict[str, Any]], lo: datetime, hi: datetime
) -> Dict[int, Cell]:
    """itemId -> Cell over every sale whose timestamp is in [lo, hi)."""
    cells: Dict[int, Cell] = defaultdict(Cell)
    for r in recs:
        ts = sale_timestamp(r)
        if lo <= ts < hi:
            cells[r["itemId"]].add(r["pricePerUnit"], r["price"])
    return cells


def two_window_relatives(
    recs: List[Dict[str, Any]],
    t0: datetime,
    tmax: datetime,
    win_days: int,
    min_sales: int,
) -> Tuple[List[Relative], int, int]:
    """Matched relatives comparing a base window (first `win_days`) directly to a
    recent window (last `win_days`). Pooling each side into one big sample gives
    stable per-item medians and sidesteps chain drift. Returns (relatives,
    base_sales, recent_sales)."""
    base = window_cells(recs, t0, t0 + timedelta(days=win_days))
    recent = window_cells(recs, tmax - timedelta(days=win_days), tmax + timedelta(seconds=1))
    rels = step_relatives(base, recent, min_sales)
    base_n = sum(c.count for c in base.values())
    recent_n = sum(c.count for c in recent.values())
    return rels, base_n, recent_n


def headline_from_relatives(
    rels: List[Relative], method: str, bootstrap: int
) -> Tuple[float, float, float]:
    """Single-step inflation % and 95% CI (low%, high%) for one matched-relative
    set (the two-window comparison)."""
    factor = step_factors(rels)[method]
    ci = bootstrap_ci([rels], method, bootstrap)
    return pct(factor), pct(ci[-1][0] / 100.0), pct(ci[-1][1] / 100.0)


def category_breakdown(
    recs: List[Dict[str, Any]],
    t0: datetime,
    tmax: datetime,
    win_days: int,
    min_sales: int,
    method: str,
) -> List[Dict[str, Any]]:
    """Per-category two-window inflation, so non-experts can see which kinds of
    goods drove the overall number."""
    by_cat: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in recs:
        by_cat[r.get("category") or "unknown"].append(r)
    out = []
    for cat, cat_recs in by_cat.items():
        rels, _, _ = two_window_relatives(cat_recs, t0, tmax, win_days, min_sales)
        if len(rels) < 5:
            continue
        gears = sum(r.gears_now for r in rels)
        out.append(
            {"category": cat, "inflationPct": pct(step_factors(rels)[method]),
             "basket": len(rels), "gears": gears}
        )
    out.sort(key=lambda c: c["gears"], reverse=True)
    return out


def full_bins(tagged: List[Tuple[int, Dict[str, Any]]], bin_name: str, t0: datetime) -> set:
    """Bin indices whose full calendar span lies within the observed data, i.e.
    dropping an incomplete leading/trailing bucket that would distort the ends."""
    width = BIN_SECONDS[bin_name]
    tmax = max(sale_timestamp(r) for _, r in tagged)
    last_full = int((tmax - t0).total_seconds() // width)
    # The final bucket is only partial unless data reaches its end.
    if (tmax - t0).total_seconds() < last_full * width + width:
        last_full -= 1
    return {b for b in {i for i, _ in tagged} if 0 <= b <= last_full}


# --------------------------------------------------------------------------- #
# Report
# --------------------------------------------------------------------------- #
def pct(factor_ratio: float) -> float:
    return round((factor_ratio - 1.0) * 100, 2)


def confidence_grade(ci_width_pp: float, median_basket: float, median_coverage: float) -> str:
    """Qualitative confidence from headline CI width (percentage points), typical
    basket size and gears coverage."""
    if median_basket >= 40 and median_coverage >= 0.6 and ci_width_pp <= 6:
        return "HIGH"
    if median_basket >= 20 and median_coverage >= 0.4 and ci_width_pp <= 15:
        return "MEDIUM"
    return "LOW"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    ap.add_argument("--item-map", type=Path, default=DEFAULT_ITEM_MAP)
    ap.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    ap.add_argument("--bin", choices=list(BIN_SECONDS), default="week")
    ap.add_argument(
        "--min-sales",
        type=int,
        default=3,
        help="Minimum sales an item needs in BOTH adjacent bins to enter the basket.",
    )
    ap.add_argument("--bootstrap", type=int, default=1000)
    args = ap.parse_args()

    print(f"Reading {args.input}…")
    rows = [
        json.loads(l)
        for l in args.input.read_text(encoding="utf-8").splitlines()
        if l.strip()
    ]
    print(f"  {len(rows):,} raw rows")
    deduped = dedup_latest(rows)
    print(f"  {len(deduped):,} unique auctions after dedup")

    item_map = load_item_map(args.item_map)
    registry = load_registry(args.registry)
    records, _ = build_records(deduped, item_map, registry)
    sold = clean_sold(records)
    print(f"  {len(sold):,} clean sold listings (excl. spam/barter/written)")

    if len(sold) < 50:
        print("Not enough clean sold listings to build an index.")
        return

    # --- Real-time distribution (reveals the backlog spike) --------------- #
    tagged, t0 = assign_bins(sold, args.bin)
    per_bin_count: Dict[int, int] = defaultdict(int)
    for idx, _ in tagged:
        per_bin_count[idx] += 1
    max_bin = max(per_bin_count)
    print(f"\nSale timeline by {args.bin} (real time, from {t0.date()}):")
    print(f"  {'bin':>4}  {'start':>10}  {'sales':>7}")
    for b in range(max_bin + 1):
        start = (t0 + timedelta(seconds=BIN_SECONDS[args.bin] * b)).date()
        bar = "#" * min(60, per_bin_count.get(b, 0) * 60 // max(per_bin_count.values()))
        print(f"  {b:>4}  {str(start):>10}  {per_bin_count.get(b, 0):>7}  {bar}")

    # --- Build the index -------------------------------------------------- #
    keep = full_bins(tagged, args.bin, t0)
    dropped = (max_bin + 1) - len(keep)
    if dropped:
        print(f"  (dropping {dropped} incomplete leading/trailing bucket(s))")
    cells = build_cells([(idx, r) for idx, r in tagged if idx in keep])
    bins_sorted = sorted(cells)
    if len(bins_sorted) < 2:
        print("\nNot enough time buckets to measure change.")
        return

    step_rels: List[List[Relative]] = []
    basket_sizes: List[int] = []
    coverages: List[float] = []
    for a, b in zip(bins_sorted, bins_sorted[1:]):
        rels = step_relatives(cells[a], cells[b], args.min_sales)
        step_rels.append(rels)
        basket_sizes.append(len(rels))
        matched_gears = sum(r.gears_now for r in rels)
        total_gears = sum(c.gears for c in cells[b].values()) or 1.0
        coverages.append(matched_gears / total_gears)

    steps = [step_factors(r) for r in step_rels]
    idx_trim = chain(steps, "trimmed")
    idx_torn = chain(steps, "tornqvist")
    idx_jev = chain(steps, "jevons")
    idx_med = chain(steps, "median")
    ci = bootstrap_ci(step_rels, "trimmed", args.bootstrap)

    print(f"\nChained index (base 100 at bin {bins_sorted[0]}, robust trimmed-mean):")
    print(f"  {'bin':>4}  {'Trimmed':>9}  {'95% CI':>18}  {'Törnqv':>8}  "
          f"{'Jevons':>8}  {'median':>8}  {'basket':>6}  {'cover':>6}")
    for i, point in enumerate(idx_trim):
        lo, hi = ci[i]
        basket = basket_sizes[i - 1] if i > 0 else 0
        cover = coverages[i - 1] if i > 0 else 0.0
        print(
            f"  {bins_sorted[i]:>4}  {point:>9.2f}  "
            f"{f'[{lo:.1f}, {hi:.1f}]':>18}  {idx_torn[i]:>8.2f}  "
            f"{idx_jev[i]:>8.2f}  {idx_med[i]:>8.2f}  {basket:>6}  {cover:>6.0%}"
        )

    # --- Two-window headline (drift-free) --------------------------------- #
    tmax = max(sale_timestamp(r) for r in sold)
    span_days = (tmax - t0).days
    win = min(30, max(7, span_days // 3))
    tw_rels, tw_base_n, tw_recent_n = two_window_relatives(
        sold, t0, tmax, win, args.min_sales
    )
    tw_inf, tw_lo, tw_hi = headline_from_relatives(tw_rels, "trimmed", args.bootstrap)
    tw_torn, _, _ = headline_from_relatives(tw_rels, "tornqvist", 1)
    tw_med, _, _ = headline_from_relatives(tw_rels, "median", 1)
    tw_jev, _, _ = headline_from_relatives(tw_rels, "jevons", 1)
    recent_cells = window_cells(sold, tmax - timedelta(days=win), tmax + timedelta(seconds=1))
    tw_gears = sum(r.gears_now for r in tw_rels)
    tw_cover = tw_gears / (sum(c.gears for c in recent_cells.values()) or 1.0)
    ci_width = tw_hi - tw_lo
    grade = confidence_grade(ci_width, len(tw_rels), tw_cover)

    print("\n" + "=" * 70)
    print("HEADLINE — price change: first vs last window (drift-free, trimmed-mean)")
    print("=" * 70)
    print(f"  windows          : first {win}d ({tw_base_n:,} sales) vs last {win}d "
          f"({tw_recent_n:,} sales)")
    print(f"  INFLATION        : {tw_inf:+.2f}%   95% CI [{tw_lo:+.2f}%, {tw_hi:+.2f}%]")
    print(f"  cross-checks     : Törnqvist {tw_torn:+.1f}%  Jevons {tw_jev:+.1f}%  "
          f"median {tw_med:+.1f}%")
    print(f"  basket           : {len(tw_rels)} items, {tw_cover:.0%} of recent gears")
    print(f"  method spread    : "
          f"{max(tw_inf, tw_torn, tw_jev, tw_med) - min(tw_inf, tw_torn, tw_jev, tw_med):.1f} pp")
    print(f"  CONFIDENCE       : {grade}  (CI width {ci_width:.1f} pp)")

    # --- Category breakdown ----------------------------------------------- #
    cats = category_breakdown(sold, t0, tmax, win, args.min_sales, "trimmed")
    if cats:
        print("\n  By category (first vs last window):")
        print(f"    {'category':<16}  {'inflation':>9}  {'basket':>6}  {'gears':>10}")
        for c in cats[:12]:
            print(f"    {c['category'][:16]:<16}  {c['inflationPct']:>+8.1f}%  "
                  f"{c['basket']:>6}  {c['gears']:>10,.0f}")
    print("=" * 70)


if __name__ == "__main__":
    main()

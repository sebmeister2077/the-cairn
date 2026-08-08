// Client-side computation of the Market Insights indicators.
//
// The dataset (`listings.json`) is already fully loaded for the other market
// pages, so rather than bloat the precomputed `summary.json` with a copy of
// every metric for every time window, we aggregate on demand here. All the
// per-listing fields needed (price, qty, sold/state, in-game hours, seller,
// delivery, observation timestamps) are present on each row.
//
// Windowing: "Last N days" means N real-world days, but measured through the
// IN-GAME clock rather than the capture's wall-clock timestamps. Vintage Story
// runs at 1 in-game minute = 2 real seconds, so 1 real day of play advances the
// in-game clock by 720 in-game hours (= 30 in-game days = one in-game month). We
// convert each listing's in-game posting time to a real-world age with that
// ratio. This is deliberate: the raw `observedUtc`/`lastObservedUtc` timestamps
// are unreliable for retroactively-captured listings (they cluster at capture
// time, not when the auction was actually posted), which made a real-timestamp
// window barely differentiate — and picked the wrong "most recent" sale.

import { useMemo } from "react";
import {
    deriveListingStatus,
    getCurrentGameHours,
    listingHasText,
    percentileSorted,
    refreshMarketReferences,
    weightedMedian,
} from "@/lib/auction";
import type {
    AuctionListing,
    ConcentrationTier,
    ConfidenceTier,
    DemandTier,
    InsightsRow,
    LiquidityTier,
    MarketInsights,
    PriceStats,
    PriceTrend,
    RecencyTier,
    VolatilityTier,
} from "@/models/auction";

/** In-game hours the clock advances per real day of play (1 in-game min = 2 real
 * sec → 720 in-game hours = 30 in-game days = one in-game month per real day). */
const GAME_HOURS_PER_REAL_DAY = 720;

/** Selectable insight windows (days), plus "since recording" and "all". */
export const INSIGHTS_WINDOWS = [
    { key: "7", label: "Last 7 days", days: 7 },
    { key: "14", label: "Last 14 days", days: 14 },
    { key: "30", label: "Last 30 days", days: 30 },
    { key: "recording", label: "Since recording", days: null },
    { key: "all", label: "All time", days: null },
] as const;

export type InsightsWindowKey = (typeof INSIGHTS_WINDOWS)[number]["key"];

/**
 * Effective look-back days for a window key. The special "recording" window is
 * the span from when capture began (`recordingStartHours`, an absolute in-game
 * hour from the summary) to the live in-game clock, expressed as days so it
 * reuses the same days-based windowing as the fixed presets. Returns null (no
 * cutoff, i.e. all time) for the "all" key or when the recording start is
 * unknown — unlike "all", "recording" excludes sales that predate capture and
 * whose timing is inferred (and thus less reliable).
 */
export function resolveWindowDays(
    windowKey: string,
    recordingStartHours?: number | null,
): number | null {
    if (windowKey === "recording") {
        if (recordingStartHours == null) return null;
        const days = (getCurrentGameHours() - recordingStartHours) / GAME_HOURS_PER_REAL_DAY;
        return days > 0 ? days : null;
    }
    return INSIGHTS_WINDOWS.find((w) => w.key === windowKey)?.days ?? null;
}


/** In-game hour at which a sold auction concluded: posting time plus the
 * (in-game) time it took to sell. Used to order and date sales by in-game time,
 * which is reliable where the real-world capture timestamps are not. */
export function saleGameHours(l: AuctionListing): number | null {
    if (l.postedTotalHours == null) return null;
    return l.postedTotalHours + (l.timeToSellHours ?? 0);
}

/**
 * Filter listings to the selected real-days window, measured through the in-game
 * clock (see the file header). `windowDays === null` (all time) returns the list
 * unchanged. Refreshes the cached reference clocks first so windowing works even
 * when the data came from a persisted cache.
 */
export function filterListingsByWindow(
    listings: AuctionListing[],
    windowDays: number | null,
): AuctionListing[] {
    if (windowDays == null) return listings;
    refreshMarketReferences(listings);
    const cutoff = getCurrentGameHours() - windowDays * GAME_HOURS_PER_REAL_DAY;
    return listings.filter(
        (l) => l.postedTotalHours != null && l.postedTotalHours >= cutoff,
    );
}

function fullPriceStats(sortedPpu: number[]): PriceStats {
    return {
        count: sortedPpu.length,
        min: sortedPpu[0],
        p10: percentileSorted(sortedPpu, 0.1),
        p25: percentileSorted(sortedPpu, 0.25),
        median: percentileSorted(sortedPpu, 0.5),
        p75: percentileSorted(sortedPpu, 0.75),
        p90: percentileSorted(sortedPpu, 0.9),
        max: sortedPpu[sortedPpu.length - 1],
        mean: sortedPpu.reduce((s, v) => s + v, 0) / sortedPpu.length,
    };
}

/** Recent-vs-older per-unit price trend, mirroring the backend's ±8% dead-band
 * logic. Ordered by in-game sale time (reliable) and needs enough dated sales on
 * both sides to avoid noisy flips. */
export function computeTrend(sold: AuctionListing[]): PriceTrend | null {
    const dated = sold
        .filter((l) => saleGameHours(l) != null)
        .sort((a, b) => saleGameHours(a)! - saleGameHours(b)!);
    if (dated.length < 8) return null;
    const recentN = Math.max(3, Math.floor(dated.length / 3));
    const recent = dated.slice(-recentN);
    const older = dated.slice(0, dated.length - recentN);
    if (older.length < 3) return null;
    const recentMed = percentileSorted(
        recent.map((l) => l.pricePerUnit).sort((a, b) => a - b),
        0.5,
    );
    const olderMed = percentileSorted(
        older.map((l) => l.pricePerUnit).sort((a, b) => a - b),
        0.5,
    );
    if (olderMed <= 0) return null;
    const change = (recentMed - olderMed) / olderMed;
    const direction = change > 0.08 ? "up" : change < -0.08 ? "down" : "flat";
    return {
        direction,
        changePct: Math.round(change * 1000) / 10,
        recentMedian: recentMed,
        olderMedian: olderMed,
        recentCount: recent.length,
        olderCount: older.length,
    };
}

function volatilityTierFor(cv: number): VolatilityTier {
    if (cv < 0.15) return "stable";
    if (cv < 0.4) return "moderate";
    return "volatile";
}

/** Evenly downsample a series to at most `max` points, preserving the first and
 * last. Keeps the inline sparkline cheap to render for high-volume items. */
export function downsampleSeries(values: number[], max: number): number[] {
    if (values.length <= max) return values;
    const out: number[] = [];
    const step = (values.length - 1) / (max - 1);
    for (let i = 0; i < max; i++) out.push(values[Math.round(i * step)]);
    return out;
}

function demandTierFor(score: number): DemandTier {
    if (score >= 75) return "hot";
    if (score >= 50) return "high";
    if (score >= 25) return "normal";
    return "low";
}

function liquidityTierFor(score: number): LiquidityTier {
    if (score >= 66) return "high";
    if (score >= 33) return "medium";
    return "low";
}

export function confidenceFor(soldCount: number): ConfidenceTier {
    if (soldCount >= 20) return "high";
    if (soldCount >= 5) return "medium";
    return "low";
}

function recencyTierFor(days: number): RecencyTier {
    if (days < 3) return "active";
    if (days < 10) return "cooling";
    return "stale";
}

function concentrationTierFor(sellerCount: number, hhi: number): ConcentrationTier {
    if (sellerCount <= 1) return "monopoly";
    if (hhi > 0.25) return "concentrated";
    if (hhi > 0.15) return "moderate";
    return "competitive";
}

/** Percentile-rank each raw value to 0–1 across the population. Robust to the
 * heavy-tailed distributions (volume, velocity) where min–max would squash
 * everything against one outlier. */
function rankNormalize(values: number[]): Map<number, number> {
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    const out = new Map<number, number>();
    const denom = Math.max(1, sorted.length - 1);
    sorted.forEach((v, i) => out.set(v, i / denom));
    return out;
}

/**
 * Compute every Market Insights indicator per item for the given window.
 * `windowDays === null` means all-time. Spam listings are always excluded.
 */
export function computeMarketInsights(
    listings: AuctionListing[],
    windowDays: number | null,
): MarketInsights {
    // Ensure the module-cached reference clocks reflect this dataset even when it
    // was restored from a persisted query cache (whose queryFn never ran).
    refreshMarketReferences(listings);
    const currentGameHours = getCurrentGameHours();
    // Window boundary in the in-game clock: N real days back = N × 720 in-game
    // hours before the latest posting (our in-game "now").
    const windowStartGameHours =
        windowDays == null ? -Infinity : currentGameHours - windowDays * GAME_HOURS_PER_REAL_DAY;

    const clean = listings.filter((l) => !l.spam);

    // In-game span (as real days) used to turn all-time counts into per-day rates.
    let earliestPosted = currentGameHours;
    for (const l of clean) {
        if (l.postedTotalHours != null && l.postedTotalHours < earliestPosted) {
            earliestPosted = l.postedTotalHours;
        }
    }
    const effectiveWindowDays =
        windowDays != null
            ? windowDays
            : Math.max(1, (currentGameHours - earliestPosted) / GAME_HOURS_PER_REAL_DAY);

    /** Whether a listing falls inside the selected window, by in-game posting time. */
    const inWindow = (l: AuctionListing) =>
        windowDays == null ||
        (l.postedTotalHours != null && l.postedTotalHours >= windowStartGameHours);

    // Group windowed listings by item; also track live supply per item across the
    // whole dataset (supply on the board is a snapshot, not window-scoped).
    const byItem = new Map<number, AuctionListing[]>();
    const activeByItem = new Map<number, AuctionListing[]>();
    for (const l of clean) {
        if (deriveListingStatus(l, currentGameHours) === "active") {
            const arr = activeByItem.get(l.itemId);
            if (arr) arr.push(l);
            else activeByItem.set(l.itemId, [l]);
        }
        if (!inWindow(l)) continue;
        const arr = byItem.get(l.itemId);
        if (arr) arr.push(l);
        else byItem.set(l.itemId, [l]);
    }

    // First pass: raw per-item aggregates.
    interface Raw {
        row: InsightsRow;
        speedSignal: number; // higher = sells faster
        freq: number; // listings per day
    }
    const raws: Raw[] = [];

    for (const [itemId, recs] of byItem) {
        const sold = recs.filter((r) => r.sold);
        const expired = recs.filter((r) => r.state === "Expired").length;
        // Written parchments/books are priced for their story, not as the raw
        // commodity, so they're excluded from every price-derived figure (fair
        // price, percentiles, volatility, deals, delivery premium, trend). They
        // still count toward volume/liquidity metrics below.
        const pricedSold = sold.filter((r) => !listingHasText(r));
        const soldPpu = pricedSold.map((r) => r.pricePerUnit).sort((a, b) => a - b);
        const priceStats = soldPpu.length ? fullPriceStats(soldPpu) : null;
        const median = priceStats?.median ?? null;

        // Quantity-weighted median per-unit price: each sold listing weighted by
        // the quantity it moved, so a single bulk trade counts for more than many
        // one-off sales (while staying robust to outlier prices).
        const weightedPricePerUnit = weightedMedian(
            pricedSold.map((r) => ({ value: r.pricePerUnit, weight: r.qty })),
        );

        // The market never revealed a price ceiling when no expired listing was
        // ever priced above the highest one that actually sold — with no evidence
        // any price was "too high", the fair price is really a floor. Written
        // parchments are excluded on both sides (priced for their content, not the
        // raw item), mirroring the item page's own chip logic.
        let upperBoundUnknown = false;
        if (soldPpu.length > 0) {
            const maxSold = soldPpu[soldPpu.length - 1];
            upperBoundUnknown = recs.every(
                (r) =>
                    r.state !== "Expired" ||
                    listingHasText(r) ||
                    r.pricePerUnit <= maxSold,
            );
        }

        const tts = sold
            .map((r) => r.timeToSellHours)
            .filter((h): h is number => h != null)
            .sort((a, b) => a - b);
        const medianTts = tts.length ? percentileSorted(tts, 0.5) : null;

        const sellThrough =
            sold.length + expired > 0 ? sold.length / (sold.length + expired) : null;

        // Volatility (dispersion): needs a few sales to be meaningful.
        let dispersionCV: number | null = null;
        let volatilityTier: VolatilityTier | null = null;
        if (priceStats && pricedSold.length >= 3 && priceStats.median > 0) {
            dispersionCV = (priceStats.p75 - priceStats.p25) / priceStats.median;
            volatilityTier = volatilityTierFor(dispersionCV);
        }

        // Deals / arbitrage.
        const dealScore =
            priceStats && priceStats.median > 0
                ? (priceStats.median - priceStats.p10) / priceStats.median
                : null;
        const active = activeByItem.get(itemId) ?? [];
        const dealsAvailable =
            priceStats != null
                ? active.filter((a) => !listingHasText(a) && a.pricePerUnit < priceStats.p25)
                    .length
                : 0;

        // Seller concentration.
        const bySeller = new Map<string, number>();
        for (const r of recs) {
            const uid = r.sellerUid ?? "?";
            bySeller.set(uid, (bySeller.get(uid) ?? 0) + 1);
        }
        const sellerCount = bySeller.size;
        let hhi: number | null = null;
        if (recs.length > 0) {
            hhi = 0;
            for (const c of bySeller.values()) {
                const share = c / recs.length;
                hhi += share * share;
            }
        }
        const concentrationTier =
            hhi != null ? concentrationTierFor(sellerCount, hhi) : null;

        // Delivery premium (needs a sample on both sides).
        const delivPpu = pricedSold
            .filter((r) => r.delivered)
            .map((r) => r.pricePerUnit)
            .sort((a, b) => a - b);
        const nonDelivPpu = pricedSold
            .filter((r) => !r.delivered)
            .map((r) => r.pricePerUnit)
            .sort((a, b) => a - b);
        let deliveryPremiumPct: number | null = null;
        if (delivPpu.length >= 3 && nonDelivPpu.length >= 3) {
            const md = percentileSorted(delivPpu, 0.5);
            const mn = percentileSorted(nonDelivPpu, 0.5);
            if (mn > 0) deliveryPremiumPct = Math.round((md / mn - 1) * 1000) / 10;
        }

        // Recency: most recent sale, ranked by in-game sale time (the real-world
        // capture timestamps are unreliable and would surface an old sale that
        // merely happened to be observed late).
        let lastSaleGameHours: number | null = null;
        let daysSinceLastSale: number | null = null;
        if (sold.length) {
            let bestHours = -Infinity;
            for (const r of sold) {
                const sh = saleGameHours(r);
                if (sh != null && sh > bestHours) bestHours = sh;
            }
            if (bestHours > -Infinity) {
                lastSaleGameHours = bestHours;
                daysSinceLastSale = Math.max(
                    0,
                    (currentGameHours - bestHours) / GAME_HOURS_PER_REAL_DAY,
                );
            }
        }
        const recencyTier =
            daysSinceLastSale != null ? recencyTierFor(daysSinceLastSale) : null;

        const salesVelocity = sold.length / effectiveWindowDays;
        const activeCount = active.length;
        const speedSignal = medianTts != null && medianTts > 0 ? 1 / medianTts : 0;
        const freq = recs.length / effectiveWindowDays;

        // Sparkline series: per-unit sold prices ordered by in-game sale time,
        // downsampled. Needs a few dated points to convey a shape.
        const datedPpu = pricedSold
            .filter((r) => saleGameHours(r) != null)
            .sort((a, b) => saleGameHours(a)! - saleGameHours(b)!)
            .map((r) => r.pricePerUnit);
        const priceSeries = datedPpu.length >= 4 ? downsampleSeries(datedPpu, 32) : null;

        // Shortage: strong demand with little stock left on the board.
        const supplyDays = salesVelocity > 0 ? activeCount / salesVelocity : Infinity;
        const shortage =
            sellThrough != null &&
            sellThrough > 0.6 &&
            sold.length >= 3 &&
            supplyDays < 3;

        const row: InsightsRow = {
            itemId,
            name: recs[0].name,
            category: recs[0].category,
            gearsTraded: sold.reduce((s, r) => s + r.price, 0),
            unitsSold: sold.reduce((s, r) => s + r.qty, 0),
            soldCount: sold.length,
            listings: recs.length,
            activeListings: activeCount,
            priceStats,
            medianPricePerUnit: median,
            weightedPricePerUnit,
            upperBoundUnknown,
            dispersionCV,
            volatilityTier,
            trend: computeTrend(pricedSold),
            priceSeries,
            sellThrough,
            medianTimeToSellHours: medianTts,
            salesVelocity,
            demandScore: null, // filled in second pass
            demandTier: null,
            shortage,
            liquidityScore: null, // filled in second pass
            liquidityTier: null,
            dealScore,
            dealsAvailable,
            confidence: confidenceFor(sold.length),
            lastSaleGameHours,
            daysSinceLastSale,
            recencyTier,
            hhi,
            concentrationTier,
            sellerCount,
            deliveryPremiumPct,
        };
        raws.push({ row, speedSignal, freq });
    }

    // Second pass: rank-normalize the heavy-tailed signals across items so the
    // composite demand / liquidity scores are comparable 0–100 figures. Only
    // items with at least one sale participate in the ranking.
    const traded = raws.filter((r) => r.row.soldCount > 0);
    const volRank = rankNormalize(traded.map((r) => r.row.unitsSold));
    const speedRank = rankNormalize(traded.map((r) => r.speedSignal));
    const freqRank = rankNormalize(traded.map((r) => r.freq));

    for (const r of raws) {
        if (r.row.soldCount === 0) continue;
        const volN = volRank.get(r.row.unitsSold) ?? 0;
        const speedN = speedRank.get(r.speedSignal) ?? 0;
        const freqN = freqRank.get(r.freq) ?? 0;
        const stN = r.row.sellThrough ?? 0;

        const demand = 100 * (0.4 * volN + 0.3 * speedN + 0.3 * stN);
        r.row.demandScore = Math.round(demand);
        r.row.demandTier = demandTierFor(demand);

        const liquidity = 100 * (0.4 * stN + 0.35 * speedN + 0.25 * freqN);
        r.row.liquidityScore = Math.round(liquidity);
        r.row.liquidityTier = liquidityTierFor(liquidity);
    }

    const rows = raws.map((r) => r.row);

    // Market-wide window totals.
    const allSoldTts: number[] = [];
    let gearsTraded = 0;
    let unitsSold = 0;
    let soldCount = 0;
    let expiredCount = 0;
    let activeListings = 0;
    let deliveryFeesPaid = 0;
    let deliveredCount = 0;
    for (const row of rows) {
        gearsTraded += row.gearsTraded;
        unitsSold += row.unitsSold;
        soldCount += row.soldCount;
        activeListings += row.activeListings;
    }
    for (const l of clean) {
        if (!inWindow(l)) continue;
        if (l.state === "Expired") expiredCount += 1;
        if (l.sold && l.timeToSellHours != null) allSoldTts.push(l.timeToSellHours);
        if (l.sold && l.delivered) {
            deliveredCount += 1;
            deliveryFeesPaid += l.deliveryFee ?? 0;
        }
    }
    allSoldTts.sort((a, b) => a - b);

    const totals = {
        gearsTraded,
        unitsSold,
        soldCount,
        activeListings,
        sellThrough:
            soldCount + expiredCount > 0 ? soldCount / (soldCount + expiredCount) : null,
        uniqueItemsTraded: traded.length,
        medianTimeToSellHours: allSoldTts.length
            ? percentileSorted(allSoldTts, 0.5)
            : null,
        deliveryFeesPaid,
        deliveredCount,
        deliveryRate: soldCount > 0 ? deliveredCount / soldCount : null,
    };

    return { windowDays, anchorGameHours: currentGameHours, rows, totals };
}

/** React hook: compute Market Insights for a window, memoized on the data + window. */
export function useMarketInsights(
    listings: AuctionListing[] | undefined,
    windowDays: number | null,
): MarketInsights | null {
    return useMemo(() => {
        if (!listings || listings.length === 0) return null;
        return computeMarketInsights(listings, windowDays);
    }, [listings, windowDays]);
}

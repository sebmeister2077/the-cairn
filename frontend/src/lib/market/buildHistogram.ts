import {
    useAuctionListings,
    useAuctionSummary,
    formatGears,
    formatRealTimeToSell,
    percentileSorted,
    weightedMedian,
    variantBase,
    useItemCatalog,
    splitOreHostRock,
    humanizeItemCode,
    listingHasText,
    listingToolAttributes,
    listingMetalType,
    listingLining,
    computeRelatedItems,
    computeCombineGroup,
    resolveItemFamily,
    metalUnitsForEntry,
    computeMetalForms,
    METAL_FAMILY_KEYS,
    deriveListingStatus,
    useCurrentGameHours,
    liquidContainerLabel,
    liquidContainerShort,
    useItemImages,
} from "@/lib/auction";


/** Build a price histogram plus a fitted log-normal density curve. `markerValue`
 * is the price the dashed "fair price" reference line should snap to (the plain
 * median by default; the quantity-weighted price when that mode is active). */
export function buildHistogram(prices: number[], bins = 24, markerValue?: number) {
    if (prices.length === 0) return { bars: [], median: 0, p25: 0, p75: 0, medianBucket: 0 };
    const sorted = [...prices].sort((a, b) => a - b);
    const median = percentileSorted(sorted, 0.5);
    const p25 = percentileSorted(sorted, 0.25);
    const p75 = percentileSorted(sorted, 0.75);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const span = max - min || 1;
    const width = span / bins;

    // Pick a label precision fine enough that adjacent buckets don't round to
    // the same value. Without this, sub-gear per-unit prices collapsed every
    // bucket to "0" or "1", producing repeated x-axis labels on bars of
    // different heights.
    const decimals = width >= 1 ? 0 : Math.min(3, Math.max(1, Math.ceil(-Math.log10(width))));
    const round = (v: number) => Number(v.toFixed(decimals));

    const counts = new Array(bins).fill(0);
    for (const p of prices) {
        const idx = Math.min(bins - 1, Math.floor((p - min) / width));
        counts[idx] += 1;
    }

    // Log-normal fit on positive prices.
    const logs = prices.filter((p) => p > 0).map((p) => Math.log(p));
    const mu = logs.reduce((s, x) => s + x, 0) / (logs.length || 1);
    const variance = logs.reduce((s, x) => s + (x - mu) ** 2, 0) / (logs.length || 1);
    const sigma = Math.sqrt(variance) || 1;
    const total = prices.length;

    const bars = counts.map((count, i) => {
        const lo = min + i * width;
        const center = lo + width / 2;
        // Log-normal PDF scaled to expected count in this bin.
        const pdf =
            center > 0
                ? (1 / (center * sigma * Math.sqrt(2 * Math.PI))) *
                Math.exp(-((Math.log(center) - mu) ** 2) / (2 * sigma * sigma))
                : 0;
        return {
            bucket: round(center),
            count,
            fit: Math.round(pdf * width * total),
        };
    });
    // Snap the fair-price marker to the bucket that actually contains it so the
    // reference line lands on a real category on the axis. Defaults to the median,
    // but follows the active price mode when a weighted marker is supplied.
    const marker = markerValue != null && Number.isFinite(markerValue) ? markerValue : median;
    const medianIdx = Math.min(bins - 1, Math.max(0, Math.floor((marker - min) / width)));
    const medianBucket = bars[medianIdx]?.bucket ?? round(marker);
    return { bars, median, p25, p75, medianBucket };
}
export type Histogram = ReturnType<typeof buildHistogram>;

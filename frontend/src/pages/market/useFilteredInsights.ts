// Apply the Insights screener filters to the derived per-item rows. Mirrors
// [pages/market/useFilteredListings.ts] but operates on `InsightsRow` and leaves
// sorting to the screener table (which owns the persisted sort state).

import { useMemo } from "react";
import type { InsightsRow } from "@/models/auction";
import type { InsightsFilters } from "@/store/slices/insightsFilters";

/** The volume dimension the numeric volume range filters against. */
export type InsightsVolumeMode = "price" | "unit";

function num(v: string): number | null {
    if (v.trim() === "") return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
}

export function filterInsights(
    rows: InsightsRow[],
    f: InsightsFilters,
    volumeMode: InsightsVolumeMode,
): InsightsRow[] {
    const q = f.q.trim().toLowerCase();
    const priceMin = num(f.priceMin);
    const priceMax = num(f.priceMax);
    const volumeMin = num(f.volumeMin);
    const volumeMax = num(f.volumeMax);
    // Sell-through is stored 0–1 but entered as a percentage.
    const stMin = num(f.sellThroughMin);
    const stMax = num(f.sellThroughMax);

    return rows.filter((r) => {
        if (q && !r.name.toLowerCase().includes(q)) return false;
        if (f.category.length && !f.category.includes(r.category)) return false;

        if (f.demand.length && !(r.demandTier && f.demand.includes(r.demandTier))) return false;
        if (f.volatility.length && !(r.volatilityTier && f.volatility.includes(r.volatilityTier)))
            return false;
        if (f.liquidity.length && !(r.liquidityTier && f.liquidity.includes(r.liquidityTier)))
            return false;
        if (f.confidence.length && !f.confidence.includes(r.confidence)) return false;
        if (
            f.concentration.length &&
            !(r.concentrationTier && f.concentration.includes(r.concentrationTier))
        )
            return false;
        if (f.trend.length && !(r.trend && f.trend.includes(r.trend.direction))) return false;

        if (f.shortageOnly && !r.shortage) return false;
        if (f.dealsOnly && r.dealsAvailable <= 0) return false;

        if (priceMin != null || priceMax != null) {
            const p = r.medianPricePerUnit;
            if (p == null) return false;
            if (priceMin != null && p < priceMin) return false;
            if (priceMax != null && p > priceMax) return false;
        }

        if (volumeMin != null || volumeMax != null) {
            const v = volumeMode === "price" ? r.gearsTraded : r.unitsSold;
            if (volumeMin != null && v < volumeMin) return false;
            if (volumeMax != null && v > volumeMax) return false;
        }

        if (stMin != null || stMax != null) {
            const st = r.sellThrough;
            if (st == null) return false;
            const pct = st * 100;
            if (stMin != null && pct < stMin) return false;
            if (stMax != null && pct > stMax) return false;
        }

        return true;
    });
}

export function useFilteredInsights(
    rows: InsightsRow[],
    filters: InsightsFilters,
    volumeMode: InsightsVolumeMode,
): InsightsRow[] {
    return useMemo(
        () => filterInsights(rows, filters, volumeMode),
        [rows, filters, volumeMode],
    );
}

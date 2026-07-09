// Market Insights screener filters — mirrors the storage pattern used by
// [store/slices/auctionFilters.ts]. Persisted (via the root envelope) so users
// return to the same screener view, including the sort column/direction.
//
// All dropdown filters are multi-select (arrays); an empty array means "any".
// Only the free-text `q` search is single-valued.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { lsReadJson, lsWriteJson } from "../persistence";
import { hydrateRoot } from "../rootActions";
import type {
    ConcentrationTier,
    ConfidenceTier,
    DemandTier,
    LiquidityTier,
    VolatilityTier,
} from "@/models/auction";

const FILTERS_LS = "insights_filters_v2";

export type InsightsTrendDirection = "up" | "down" | "flat";

export interface InsightsFilters {
    q: string;
    category: string[]; // empty = all
    demand: DemandTier[];
    volatility: VolatilityTier[];
    liquidity: LiquidityTier[];
    confidence: ConfidenceTier[];
    /** Seller-concentration tiers (the "Sellers" column). */
    concentration: ConcentrationTier[];
    trend: InsightsTrendDirection[];
    shortageOnly: boolean;
    dealsOnly: boolean;
    /** Only items whose upper price bound is unknown (fair price is a floor). */
    upperBoundUnknownOnly: boolean;
    // Kept as strings so the inputs stay controlled. Price = median/unit (gears);
    // volume = current volume-mode value; sellThrough = percent (0–100).
    priceMin: string;
    priceMax: string;
    volumeMin: string;
    volumeMax: string;
    sellThroughMin: string;
    sellThroughMax: string;
    // Persisted screener sort.
    sortKey: string;
    sortDir: "asc" | "desc";
}

export const DEFAULT_INSIGHTS_FILTERS: InsightsFilters = {
    q: "",
    category: [],
    demand: [],
    volatility: [],
    liquidity: [],
    confidence: [],
    concentration: [],
    trend: [],
    shortageOnly: false,
    dealsOnly: false,
    upperBoundUnknownOnly: false,
    priceMin: "",
    priceMax: "",
    volumeMin: "",
    volumeMax: "",
    sellThroughMin: "",
    sellThroughMax: "",
    sortKey: "volume",
    sortDir: "desc",
};

/** Multi-select (array) filter fields, so we can normalise/compare them generically. */
const ARRAY_KEYS: (keyof InsightsFilters)[] = [
    "category",
    "demand",
    "volatility",
    "liquidity",
    "confidence",
    "concentration",
    "trend",
];

/** Coerce stored data into the current shape (e.g. old single-string fields → arrays). */
export function normalizeInsightsFilters(raw: Partial<InsightsFilters> | undefined): InsightsFilters {
    const merged = { ...DEFAULT_INSIGHTS_FILTERS, ...(raw ?? {}) } as InsightsFilters;
    for (const k of ARRAY_KEYS) {
        const v = merged[k] as unknown;
        if (Array.isArray(v)) continue;
        // Legacy scalar → array (drop empty-string sentinels).
        (merged[k] as unknown) = v == null || v === "" ? [] : [v];
    }
    return merged;
}

export function loadInitialInsightsFilters(): InsightsFilters {
    return normalizeInsightsFilters(lsReadJson<Partial<InsightsFilters>>(FILTERS_LS, {}));
}

export const insightsFiltersSlice = createSlice({
    name: "insightsFilters",
    initialState: loadInitialInsightsFilters(),
    reducers: {
        setInsightsFilters(_state, action: PayloadAction<InsightsFilters>) {
            return action.payload;
        },
        patchInsightsFilters(state, action: PayloadAction<Partial<InsightsFilters>>) {
            Object.assign(state, action.payload);
        },
        resetInsightsFilters(state) {
            // Preserve the current sort — a "Reset" on the filter bar should clear
            // the filters without also yanking the column the user is sorting by.
            return { ...DEFAULT_INSIGHTS_FILTERS, sortKey: state.sortKey, sortDir: state.sortDir };
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.insightsFilters as Partial<InsightsFilters> | undefined;
            return next ? normalizeInsightsFilters(next) : state;
        });
    },
});

export const { setInsightsFilters, patchInsightsFilters, resetInsightsFilters } =
    insightsFiltersSlice.actions;

export function persistInsightsFilters(
    getSlice: () => InsightsFilters,
    prev: InsightsFilters,
) {
    const s = getSlice();
    if (s !== prev) lsWriteJson(FILTERS_LS, s);
}

/** Filter-only fields (excludes sort) — used to decide if a "Reset" is a no-op. */
export const INSIGHTS_FILTER_KEYS: (keyof InsightsFilters)[] = [
    "q",
    "category",
    "demand",
    "volatility",
    "liquidity",
    "confidence",
    "concentration",
    "trend",
    "shortageOnly",
    "dealsOnly",
    "priceMin",
    "priceMax",
    "volumeMin",
    "volumeMax",
    "sellThroughMin",
    "sellThroughMax",
];

/** True when no filter (ignoring sort) is active — used to disable "Reset". */
export function isDefaultInsightsFilters(f: InsightsFilters): boolean {
    return INSIGHTS_FILTER_KEYS.every((k) => {
        const v = f[k];
        if (Array.isArray(v)) return v.length === 0;
        return v === DEFAULT_INSIGHTS_FILTERS[k];
    });
}

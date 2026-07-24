// User-chosen "elite" definition for the Overview page's "Wealth concentration"
// panel (see [pages/market/MarketWealthChart.tsx]). Held in the store so the
// choice persists across reloads via the root envelope — same pattern as the
// other market preference slices.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { hydrateRoot } from "../rootActions";

/** How the elite are defined: the richest N% of traders, or everyone worth at
 *  least a fixed number of gears. */
export type WealthEliteMode = "percent" | "amount";

export interface MarketWealthState {
    mode: WealthEliteMode;
    /** Richest N% of traders (1–50), used in `percent` mode. */
    percent: number;
    /** Minimum net worth (gears) to be elite, used in `amount` mode. `null`
     *  means "not chosen yet" — the chart falls back to the data-derived
     *  top-10% wealth boundary until the user picks a value. */
    threshold: number | null;
}

export const DEFAULT_MARKET_WEALTH: MarketWealthState = {
    mode: "percent",
    percent: 10,
    threshold: null,
};

const clampPercent = (v: number): number =>
    Math.min(50, Math.max(1, Math.round(Number(v) || DEFAULT_MARKET_WEALTH.percent)));

/** Coerce stored/partial data into the current shape with sane bounds. */
export function normalizeMarketWealth(
    raw: Partial<MarketWealthState> | undefined,
): MarketWealthState {
    const merged = { ...DEFAULT_MARKET_WEALTH, ...(raw ?? {}) };
    const threshold =
        merged.threshold == null || !Number.isFinite(Number(merged.threshold))
            ? null
            : Math.max(0, Math.round(Number(merged.threshold)));
    return {
        mode: merged.mode === "amount" ? "amount" : "percent",
        percent: clampPercent(merged.percent),
        threshold,
    };
}

export const marketWealthSlice = createSlice({
    name: "marketWealth",
    initialState: DEFAULT_MARKET_WEALTH,
    reducers: {
        setWealthMode(state, action: PayloadAction<WealthEliteMode>) {
            state.mode = action.payload === "amount" ? "amount" : "percent";
        },
        setWealthPercent(state, action: PayloadAction<number>) {
            state.percent = clampPercent(action.payload);
        },
        setWealthThreshold(state, action: PayloadAction<number | null>) {
            const v = action.payload;
            state.threshold = v == null || !Number.isFinite(v) ? null : Math.max(0, Math.round(v));
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.marketWealth as Partial<MarketWealthState> | undefined;
            return next ? normalizeMarketWealth(next) : state;
        });
    },
});

export const { setWealthMode, setWealthPercent, setWealthThreshold } = marketWealthSlice.actions;

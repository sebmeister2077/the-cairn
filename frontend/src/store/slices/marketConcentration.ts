// User-adjustable thresholds for the item page's "Market concentration" panel
// (see [pages/market/ItemConcentrationSection.tsx]). Held in the store so the
// values persist across reloads via the root envelope — same pattern as the
// other market preference slices, rather than a bespoke localStorage key.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { hydrateRoot } from "../rootActions";

export interface MarketConcentrationState {
    /** Minimum completed trades before a player is listed as dominant. */
    minTrades: number;
    /** Minimum unit-share (0–100 %) before a player is listed as dominant. */
    minSharePct: number;
}

export const DEFAULT_MARKET_CONCENTRATION: MarketConcentrationState = {
    minTrades: 3,
    minSharePct: 40,
};

/** Coerce stored/partial data into the current shape with sane bounds. */
export function normalizeMarketConcentration(
    raw: Partial<MarketConcentrationState> | undefined,
): MarketConcentrationState {
    const merged = { ...DEFAULT_MARKET_CONCENTRATION, ...(raw ?? {}) };
    return {
        minTrades: Math.max(1, Math.floor(Number(merged.minTrades) || DEFAULT_MARKET_CONCENTRATION.minTrades)),
        minSharePct: Math.min(
            100,
            Math.max(0, Math.floor(Number(merged.minSharePct) || 0)),
        ),
    };
}

export const marketConcentrationSlice = createSlice({
    name: "marketConcentration",
    initialState: DEFAULT_MARKET_CONCENTRATION,
    reducers: {
        setMinTrades(state, action: PayloadAction<number>) {
            state.minTrades = Math.max(1, Math.floor(action.payload || 1));
        },
        setMinSharePct(state, action: PayloadAction<number>) {
            state.minSharePct = Math.min(100, Math.max(0, Math.floor(action.payload || 0)));
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.marketConcentration as
                | Partial<MarketConcentrationState>
                | undefined;
            return next ? normalizeMarketConcentration(next) : state;
        });
    },
});

export const { setMinTrades, setMinSharePct } = marketConcentrationSlice.actions;

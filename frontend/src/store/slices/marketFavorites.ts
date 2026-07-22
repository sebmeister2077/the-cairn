// Favorite market items — a set of item IDs the user has starred on the Market
// Insights screener (and potentially other market pages). Held in the store so
// it persists across reloads via the root envelope, same pattern as the other
// market preference slices rather than a bespoke localStorage key.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { hydrateRoot } from "../rootActions";

export interface MarketFavoritesState {
    /** Favorited item IDs. Stored as an array (JSON-serialisable); callers that
     * need fast membership tests build a `Set` from it. */
    ids: number[];
}

export const INITIAL_MARKET_FAVORITES: MarketFavoritesState = {
    ids: [],
};

/** Coerce stored/partial data into the current shape (dedupe, drop non-numbers). */
export function normalizeMarketFavorites(
    raw: Partial<MarketFavoritesState> | undefined,
): MarketFavoritesState {
    const list = Array.isArray(raw?.ids) ? raw.ids : [];
    const ids = Array.from(
        new Set(list.filter((v): v is number => typeof v === "number" && Number.isFinite(v))),
    );
    return { ids };
}

export const marketFavoritesSlice = createSlice({
    name: "marketFavorites",
    initialState: INITIAL_MARKET_FAVORITES,
    reducers: {
        toggleFavorite(state, action: PayloadAction<number>) {
            const id = action.payload;
            const i = state.ids.indexOf(id);
            if (i >= 0) state.ids.splice(i, 1);
            else state.ids.push(id);
        },
        addFavorite(state, action: PayloadAction<number>) {
            if (!state.ids.includes(action.payload)) state.ids.push(action.payload);
        },
        removeFavorite(state, action: PayloadAction<number>) {
            const i = state.ids.indexOf(action.payload);
            if (i >= 0) state.ids.splice(i, 1);
        },
        clearFavorites(state) {
            state.ids = [];
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.marketFavorites as
                | Partial<MarketFavoritesState>
                | undefined;
            return next ? normalizeMarketFavorites(next) : state;
        });
    },
});

export const { toggleFavorite, addFavorite, removeFavorite, clearFavorites } =
    marketFavoritesSlice.actions;

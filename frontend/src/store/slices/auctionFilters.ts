// Auction House listings filters — mirrors the storage pattern used by
// [store/slices/adminUsersFilters.ts]. Persisted so users return to the
// same view.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { lsReadJson, lsWriteJson } from "../persistence";
import { hydrateRoot } from "../rootActions";

const FILTERS_LS = "auction_filters_v1";

export type AuctionStateFilter = "all" | "sold" | "active" | "removed" | "expired";
export type AuctionSortKey =
    | "date"
    | "price"
    | "pricePerUnit"
    | "qty"
    | "name";

export interface AuctionFilters {
    q: string;
    category: string; // "" = all
    priceMin: string; // kept as strings so the inputs stay controlled
    priceMax: string;
    state: AuctionStateFilter;
    deliveredOnly: boolean;
    excludeSpam: boolean;
    excludeExternalTrades: boolean;
    /**
     * Admin-only: show only expired/cancelled listings that are still sitting on
     * the live board (observed in the latest capture sweep), i.e. not yet
     * retrieved by the seller — these are still buyable due to a game bug.
     */
    unpickedExpiredOnly: boolean;
    /** Admin-only display toggle: show the raw AuctionId column. */
    showAuctionId: boolean;
    /** Comma-separated buyer/seller names to hide from the listings. */
    excludePlayers: string;
    sort: AuctionSortKey;
    sortDir: "asc" | "desc";
}

export const DEFAULT_AUCTION_FILTERS: AuctionFilters = {
    q: "",
    category: "",
    priceMin: "",
    priceMax: "",
    state: "all",
    deliveredOnly: false,
    excludeSpam: true,
    excludeExternalTrades: true,
    unpickedExpiredOnly: false,
    showAuctionId: false,
    excludePlayers: "",
    sort: "date",
    sortDir: "desc",
};

export function loadInitialAuctionFilters(): AuctionFilters {
    const stored = lsReadJson<Partial<AuctionFilters>>(FILTERS_LS, {});
    return { ...DEFAULT_AUCTION_FILTERS, ...stored };
}

export const auctionFiltersSlice = createSlice({
    name: "auctionFilters",
    initialState: loadInitialAuctionFilters(),
    reducers: {
        setAuctionFilters(_state, action: PayloadAction<AuctionFilters>) {
            return action.payload;
        },
        patchAuctionFilters(state, action: PayloadAction<Partial<AuctionFilters>>) {
            Object.assign(state, action.payload);
        },
        resetAuctionFilters() {
            return { ...DEFAULT_AUCTION_FILTERS };
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.auctionFilters as AuctionFilters | undefined;
            return next ? { ...DEFAULT_AUCTION_FILTERS, ...next } : state;
        });
    },
});

export const { setAuctionFilters, patchAuctionFilters, resetAuctionFilters } =
    auctionFiltersSlice.actions;

export function persistAuctionFilters(
    getSlice: () => AuctionFilters,
    prev: AuctionFilters,
) {
    const s = getSlice();
    if (s !== prev) lsWriteJson(FILTERS_LS, s);
}

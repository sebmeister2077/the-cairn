// Recently-viewed market items — a short, ordered list of the item pages the
// user most recently opened, surfaced as quick-jump chips on the Item Search
// screen. Held in the store so it persists across reloads via the root
// envelope, same pattern as `marketFavorites` rather than a bespoke
// localStorage key.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { hydrateRoot } from "../rootActions";

export interface RecentItem {
    itemId: number;
    /** Resolved display name at the time of the visit (fallback for the chip). */
    name: string;
}

export interface RecentItemsState {
    /** Most-recent first. De-duplicated by `itemId`, capped at `MAX_RECENT_ITEMS`. */
    items: RecentItem[];
}

// Keep the list short — these are quick-access chips, not a full history.
export const MAX_RECENT_ITEMS = 10;

export const INITIAL_RECENT_ITEMS: RecentItemsState = { items: [] };

/** Coerce stored/partial data into the current shape (dedupe, drop malformed). */
export function normalizeRecentItems(
    raw: Partial<RecentItemsState> | undefined,
): RecentItemsState {
    const list = Array.isArray(raw?.items) ? raw.items : [];
    const seen = new Set<number>();
    const items: RecentItem[] = [];
    for (const it of list) {
        if (!it || typeof it !== "object") continue;
        const itemId = (it as RecentItem).itemId;
        const name = (it as RecentItem).name;
        if (!Number.isFinite(itemId) || typeof name !== "string" || !name.trim()) continue;
        if (seen.has(itemId)) continue;
        seen.add(itemId);
        items.push({ itemId, name: name.trim() });
        if (items.length >= MAX_RECENT_ITEMS) break;
    }
    return { items };
}

export const recentItemsSlice = createSlice({
    name: "recentItems",
    initialState: INITIAL_RECENT_ITEMS,
    reducers: {
        // Record a visit: move the item to the front (de-duped by id) and cap
        // the list. A no-op when it's already the most recent identical entry,
        // so re-renders on the item page don't churn the store.
        recordRecentItem(state, action: PayloadAction<RecentItem>) {
            const { itemId } = action.payload;
            const name = action.payload.name.trim();
            if (!Number.isFinite(itemId) || !name) return;
            if (state.items[0]?.itemId === itemId && state.items[0]?.name === name) return;
            state.items = [
                { itemId, name },
                ...state.items.filter((it) => it.itemId !== itemId),
            ].slice(0, MAX_RECENT_ITEMS);
        },
        clearRecentItems(state) {
            state.items = [];
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.recentItems as Partial<RecentItemsState> | undefined;
            return next ? normalizeRecentItems(next) : state;
        });
    },
});

export const { recordRecentItem, clearRecentItems } = recentItemsSlice.actions;

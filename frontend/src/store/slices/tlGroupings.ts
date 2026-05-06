// Favorite TL groupings slice. The on-disk shape and seeding helpers are
// reused from [lib/tl-groupings.ts] so import/export files stay
// byte-compatible with the legacy implementation.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { loadGroupings, saveGroupings, type TLGrouping } from "@/lib/tl-groupings";
import { hydrateRoot } from "../rootActions";

export interface TLGroupingsState {
    items: TLGrouping[];
}

export function loadInitialTLGroupingsState(): TLGroupingsState {
    return { items: loadGroupings() };
}

export const tlGroupingsSlice = createSlice({
    name: "tlGroupings",
    initialState: loadInitialTLGroupingsState(),
    reducers: {
        setGroupings(state, action: PayloadAction<TLGrouping[]>) {
            state.items = action.payload;
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.tlGroupings as
                | TLGroupingsState
                | undefined;
            return next ?? state;
        });
    },
});

export const { setGroupings } = tlGroupingsSlice.actions;

export function persistTLGroupings(
    getSlice: () => TLGroupingsState,
    prev: TLGroupingsState,
) {
    const s = getSlice();
    if (s.items !== prev.items) saveGroupings(s.items);
}

/** Cross-tab: another tab wrote the groupings key. */
export function reconcileTLGroupingsFromStorage(key: string) {
    if (key !== "tops-map-tl-groupings") return null;
    return setGroupings(loadGroupings());
}

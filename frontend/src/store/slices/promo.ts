// Promotion-banner UI state. Currently just tracks which time-limited promos
// the user has dismissed, keyed by promo id so multiple / future promos each
// remember their own state. Persisted via the root envelope (see
// [../rootPersistence.ts]).

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { hydrateRoot } from "../rootActions";

export interface PromoState {
    /** Map of promo id -> dismissed. Absent / false means still visible. */
    dismissed: Record<string, boolean>;
    /**
     * Map of promo id -> whether the details dialog has ever been opened.
     * Persisted so a refresh between opening details and dismissing still
     * classifies the dismiss as "after reading" rather than "outright".
     */
    detailsOpened: Record<string, boolean>;
}

export const initialPromoState: PromoState = { dismissed: {}, detailsOpened: {} };

export const promoSlice = createSlice({
    name: "promo",
    initialState: initialPromoState,
    reducers: {
        dismissPromo(state, action: PayloadAction<string>) {
            state.dismissed[action.payload] = true;
        },
        markPromoDetailsOpened(state, action: PayloadAction<string>) {
            state.detailsOpened[action.payload] = true;
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.promo as PromoState | undefined;
            if (!next) return state;
            // Tolerate envelopes written before `detailsOpened` existed.
            return { dismissed: next.dismissed ?? {}, detailsOpened: next.detailsOpened ?? {} };
        });
    },
});

export const { dismissPromo, markPromoDetailsOpened } = promoSlice.actions;

// Promotion-banner UI state. Currently just tracks which time-limited promos
// the user has dismissed, keyed by promo id so multiple / future promos each
// remember their own state. Persisted via the root envelope (see
// [../rootPersistence.ts]).

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { hydrateRoot } from "../rootActions";

export interface PromoState {
    /** Map of promo id -> dismissed. Absent / false means still visible. */
    dismissed: Record<string, boolean>;
}

export const initialPromoState: PromoState = { dismissed: {} };

export const promoSlice = createSlice({
    name: "promo",
    initialState: initialPromoState,
    reducers: {
        dismissPromo(state, action: PayloadAction<string>) {
            state.dismissed[action.payload] = true;
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.promo as PromoState | undefined;
            return next ?? state;
        });
    },
});

export const { dismissPromo } = promoSlice.actions;

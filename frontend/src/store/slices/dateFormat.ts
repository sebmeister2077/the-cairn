// Date-format preference slice. Persistence is handled by the root
// envelope (see [../rootPersistence.ts]); this slice only needs to hold
// the current preference and merge cross-tab `hydrateRoot` updates.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { hydrateRoot } from "../rootActions";
import type { DateFormatPref } from "@/lib/dateFormat";

export interface DateFormatState {
    pref: DateFormatPref;
}

export const initialDateFormatState: DateFormatState = { pref: "system" };

export const dateFormatSlice = createSlice({
    name: "dateFormat",
    initialState: initialDateFormatState,
    reducers: {
        setDateFormatPref(state, action: PayloadAction<DateFormatPref>) {
            state.pref = action.payload;
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.dateFormat as DateFormatState | undefined;
            return next ?? state;
        });
    },
});

export const { setDateFormatPref } = dateFormatSlice.actions;

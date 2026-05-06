// Theme slice — preference only. Resolved theme is derived in components
// from preference + system color-scheme so we don't have to keep two
// fields in lockstep.
//
// Persistence uses the same versioned envelope (`${version}:${value}`) as
// the legacy helpers in [lib/theme.ts] so existing users keep their
// stored choice on first load after the upgrade.

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { lsRead, lsWrite } from "../persistence";
import { hydrateRoot } from "../rootActions";

export const THEME_VERSION = "1";
const THEME_LS = "theme_preference";

export type ThemePreference = "auto" | "light" | "dark";

export interface ThemeState {
    preference: ThemePreference;
}

function readPreferenceFromStorage(): ThemePreference {
    const raw = lsRead(THEME_LS);
    if (!raw) return "auto";
    const [version, value] = raw.split(":");
    if (version !== THEME_VERSION) return "auto";
    if (value === "auto" || value === "light" || value === "dark") return value;
    return "auto";
}

export function loadInitialThemeState(): ThemeState {
    return { preference: readPreferenceFromStorage() };
}

export const themeSlice = createSlice({
    name: "theme",
    initialState: loadInitialThemeState(),
    reducers: {
        setThemePreference(state, action: PayloadAction<ThemePreference>) {
            state.preference = action.payload;
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.theme as ThemeState | undefined;
            return next ?? state;
        });
    },
});

export const { setThemePreference } = themeSlice.actions;

export function persistTheme(getSlice: () => ThemeState, prev: ThemeState) {
    const s = getSlice();
    if (s.preference !== prev.preference) {
        lsWrite(THEME_LS, `${THEME_VERSION}:${s.preference}`);
    }
}

export function reconcileThemeFromStorage(key: string) {
    if (key !== THEME_LS) return null;
    return setThemePreference(readPreferenceFromStorage());
}

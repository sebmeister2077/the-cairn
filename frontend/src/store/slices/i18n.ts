import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { lsRead, lsWrite } from "../persistence";
import { hydrateRoot } from "../rootActions";
import type { Locale } from "@/lib/i18n";
import { DEFAULT_LOCALE } from "@/lib/i18n";

const I18N_VERSION = "1";
const I18N_LS = "i18n_locale";

export interface I18nState {
    locale: Locale;
}

function isLocale(value: string): value is Locale {
    return value === "en" || value === "ru";
}

function detectFromNavigator(): Locale {
    if (typeof window === "undefined") return DEFAULT_LOCALE;
    const candidates = window.navigator.languages?.length
        ? window.navigator.languages
        : [window.navigator.language];
    for (const candidate of candidates) {
        const base = candidate.toLowerCase().split("-")[0];
        if (isLocale(base)) return base;
    }
    return DEFAULT_LOCALE;
}

function readLocaleFromStorage(): Locale {
    const raw = lsRead(I18N_LS);
    if (!raw) return detectFromNavigator();
    const [version, value] = raw.split(":");
    if (version !== I18N_VERSION) return detectFromNavigator();
    return isLocale(value) ? value : detectFromNavigator();
}

export function loadInitialI18nState(): I18nState {
    return { locale: readLocaleFromStorage() };
}

export const i18nSlice = createSlice({
    name: "i18n",
    initialState: loadInitialI18nState(),
    reducers: {
        setLocale(state, action: PayloadAction<Locale>) {
            state.locale = action.payload;
        },
    },
    extraReducers: (builder) => {
        builder.addCase(hydrateRoot, (state, action) => {
            const next = action.payload.i18n as I18nState | undefined;
            return next ?? state;
        });
    },
});

export const { setLocale } = i18nSlice.actions;

export function persistI18n(getSlice: () => I18nState, prev: I18nState) {
    const next = getSlice();
    if (next.locale !== prev.locale) {
        lsWrite(I18N_LS, `${I18N_VERSION}:${next.locale}`);
    }
}

export function reconcileI18nFromStorage(key: string) {
    if (key !== I18N_LS) return null;
    return setLocale(readLocaleFromStorage());
}
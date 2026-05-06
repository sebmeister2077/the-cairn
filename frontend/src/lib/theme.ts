// Theme preference helpers — Redux-backed.
//
// The slice in [store/slices/theme.ts] owns the runtime value and writes
// it to localStorage with the same versioned envelope as before. These
// functions are kept as thin wrappers so non-React callers can stay on the
// existing API surface (Phase 4 cleanup will fold them into selectors).

import { store } from "@/store";
import {
    setThemePreference,
    type ThemePreference,
} from "@/store/slices/theme";

export const THEME_VERSION = "1";

export type { ThemePreference } from "@/store/slices/theme";
export type ResolvedTheme = "light" | "dark";

export const THEME_CHANGED_EVENT = "theme-changed";

export function loadThemePreference(): ThemePreference {
    return store.getState().theme.preference;
}

export function saveThemePreference(pref: ThemePreference) {
    store.dispatch(setThemePreference(pref));
    // Phase 4 cleanup: drop this once every consumer has switched to a
    // useAppSelector. Kept dispatched so legacy ThemeProvider listeners
    // still react during the transition.
    window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: pref }));
}

export function getSystemTheme(): ResolvedTheme {
    if (typeof window === "undefined" || !window.matchMedia) return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
    return pref === "auto" ? getSystemTheme() : pref;
}

export function applyTheme(resolved: ResolvedTheme) {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.classList.toggle("light", resolved === "light");
    root.style.colorScheme = resolved;
}

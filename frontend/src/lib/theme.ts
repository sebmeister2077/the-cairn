// Theme preference storage + resolution helpers.
//
// The user picks one of three preferences (Auto / Light / Dark). "Auto" follows
// the OS via `prefers-color-scheme`. The resolved theme ("light" | "dark") is
// applied by toggling a class on <html>; existing CSS variables in index.css
// (`:root` for light, `.dark` for dark) handle the rest.
//
// Storage is versioned (mirrors lib/consent.ts) so we can invalidate values
// later without leaving stale data behind.

export const THEME_VERSION = "1";
const THEME_KEY = "theme_preference";

export type ThemePreference = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_CHANGED_EVENT = "theme-changed";

export function loadThemePreference(): ThemePreference {
    try {
        const raw = localStorage.getItem(THEME_KEY);
        if (!raw) return "auto";
        const [version, value] = raw.split(":");
        if (version !== THEME_VERSION) return "auto";
        if (value === "auto" || value === "light" || value === "dark") return value;
        return "auto";
    } catch {
        return "auto";
    }
}

export function saveThemePreference(pref: ThemePreference) {
    try {
        localStorage.setItem(THEME_KEY, `${THEME_VERSION}:${pref}`);
    } catch {
        // ignore — storage may be disabled / denied
    }
    // Notify same-tab listeners (storage event only fires across tabs).
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

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  THEME_CHANGED_EVENT,
  applyTheme,
  getSystemTheme,
  loadThemePreference,
  saveThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (pref: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Initialize from storage so first render matches the pre-paint script in
  // index.html (no class flicker after hydration).
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    typeof window === "undefined" ? "auto" : loadThemePreference(),
  );
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    typeof window === "undefined" ? "light" : getSystemTheme(),
  );

  // Derived: never stored as state, so no cascading-render risk.
  const resolved: ResolvedTheme = preference === "auto" ? systemTheme : preference;

  // Apply to <html> whenever the resolved theme changes.
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  // Track OS color-scheme changes (matters only when preference is "auto",
  // but we keep the listener live so toggling back to auto picks up changes).
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? "dark" : "light");
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Sync across tabs (storage event) and same-tab listeners (custom event).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "theme_preference") return;
      setPreferenceState(loadThemePreference());
    };
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<ThemePreference>).detail;
      if (detail === "auto" || detail === "light" || detail === "dark") {
        setPreferenceState(detail);
      } else {
        setPreferenceState(loadThemePreference());
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(THEME_CHANGED_EVENT, onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(THEME_CHANGED_EVENT, onCustom);
    };
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolved,
      setPreference: (pref) => {
        saveThemePreference(pref);
        setPreferenceState(pref);
      },
    }),
    [preference, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}

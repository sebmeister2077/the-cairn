import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  applyTheme,
  getSystemTheme,
  saveThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";
import { useAppSelector } from "@/store/hooks";

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (pref: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Preference is owned by the Redux store now — selecting it makes this
  // component re-render automatically when any caller dispatches a change
  // (including cross-tab updates handled by store/crossTabSync.ts), so the
  // legacy `THEME_CHANGED_EVENT` / `storage` listeners aren't needed here.
  const preference = useAppSelector((s) => s.theme.preference);
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

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolved,
      setPreference: (pref) => {
        // Goes through the Redux slice; the selector above will re-render us.
        saveThemePreference(pref);
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

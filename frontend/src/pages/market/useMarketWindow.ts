// Shared time-range ("window") selection for the market pages. Keeping the
// selected window in a tiny module-level store (instead of per-page state) lets
// the Insights page and an item page show the *same* range as you navigate
// between them, so the numbers stay consistent and the transition feels
// seamless. The choice is persisted to localStorage so it also survives reloads.

import { useSyncExternalStore } from "react";
import { writeIfConsented } from "@/lib/consent";
import { INSIGHTS_WINDOWS, type InsightsWindowKey } from "./useMarketInsights";

const STORAGE_KEY = "market.windowKey";
const VALID = new Set<string>(INSIGHTS_WINDOWS.map((w) => w.key));

function load(): InsightsWindowKey {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v && VALID.has(v)) return v as InsightsWindowKey;
    } catch {
        /* localStorage unavailable — fall back to the default */
    }
    return "30";
}

let current: InsightsWindowKey = load();
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

/** Update the shared window and notify every subscribed page. */
export function setMarketWindow(key: InsightsWindowKey): void {
    if (key === current) return;
    current = key;
    writeIfConsented(STORAGE_KEY, key);
    listeners.forEach((l) => l());
}

/**
 * Read (and set) the shared market time-range window. Every page using this hook
 * stays in sync, so selecting a range on one page carries over to the others.
 */
export function useMarketWindow(): [InsightsWindowKey, (key: InsightsWindowKey) => void] {
    const key = useSyncExternalStore(
        subscribe,
        () => current,
        () => current,
    );
    return [key, setMarketWindow];
}

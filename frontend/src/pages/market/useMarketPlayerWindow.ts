// Time-range ("window") selection for the player-profile pages ONLY.
//
// This is deliberately a SEPARATE store from `useMarketWindow` (which the
// Insights / item / converter pages share). A player profile is a focused,
// investigative view, so the range you pick there should not bleed into — or be
// overwritten by — the market-wide pages, and vice versa. It reuses the same
// window options (7 / 14 / 30 days / all time) and the same persist-to-
// localStorage pattern, just under its own key.

import { useSyncExternalStore } from "react";
import { INSIGHTS_WINDOWS, type InsightsWindowKey } from "./useMarketInsights";

const STORAGE_KEY = "market.playerWindowKey";
const VALID = new Set<string>(INSIGHTS_WINDOWS.map((w) => w.key));

function load(): InsightsWindowKey {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v && VALID.has(v)) return v as InsightsWindowKey;
    } catch {
        /* localStorage unavailable — fall back to the default */
    }
    return "all";
}

let current: InsightsWindowKey = load();
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

/** Update the shared player-profile window and notify every subscribed page. */
export function setPlayerWindow(key: InsightsWindowKey): void {
    if (key === current) return;
    current = key;
    try {
        localStorage.setItem(STORAGE_KEY, key);
    } catch {
        /* ignore persistence failures */
    }
    listeners.forEach((l) => l());
}

/**
 * Read (and set) the player-profile time-range window. Independent of the
 * market-wide `useMarketWindow`, so selecting a range here never changes the
 * Insights/item pages and is remembered separately across reloads.
 */
export function usePlayerWindow(): [InsightsWindowKey, (key: InsightsWindowKey) => void] {
    const key = useSyncExternalStore(
        subscribe,
        () => current,
        () => current,
    );
    return [key, setPlayerWindow];
}

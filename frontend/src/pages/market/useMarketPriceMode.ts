// Shared "price mode" selection for the market pages — whether prices are shown
// as the plain median of sold listings ("median") or a quantity-weighted median
// ("weighted"), where a listing's per-unit price counts in proportion to the
// quantity it moved (so one bulk trade outweighs many one-off sales). Kept in a
// tiny module-level store (mirroring `useMarketWindow`) so the Insights,
// Converter and item pages all reflect the same choice as you navigate between
// them, and persisted to localStorage so it survives reloads.

import { useSyncExternalStore } from "react";

export type MarketPriceMode = "median" | "weighted";

const STORAGE_KEY = "market.priceMode";
const VALID = new Set<MarketPriceMode>(["median", "weighted"]);

function load(): MarketPriceMode {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v && VALID.has(v as MarketPriceMode)) return v as MarketPriceMode;
    } catch {
        /* localStorage unavailable — fall back to the default */
    }
    return "weighted";
}

let current: MarketPriceMode = load();
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

/** Update the shared price mode and notify every subscribed page. */
export function setMarketPriceMode(mode: MarketPriceMode): void {
    if (mode === current) return;
    current = mode;
    try {
        localStorage.setItem(STORAGE_KEY, mode);
    } catch {
        /* ignore persistence failures */
    }
    listeners.forEach((l) => l());
}

/** Read the current shared price mode without subscribing (for one-off reads). */
export function getMarketPriceMode(): MarketPriceMode {
    return current;
}

/**
 * Read (and set) the shared market price mode. Every page using this hook stays
 * in sync, so switching between median and quantity-weighted on one page carries
 * over to the others.
 */
export function useMarketPriceMode(): [MarketPriceMode, (mode: MarketPriceMode) => void] {
    const mode = useSyncExternalStore(
        subscribe,
        () => current,
        () => current,
    );
    return [mode, setMarketPriceMode];
}

// Persisted column-visibility for the Market Insights screener. The screener has
// many columns; this lets users hide the ones they don't care about (the wide
// table then needs less horizontal scrolling). State is a set of hidden column
// keys kept in a tiny module-level store (mirroring `useMarketWindow`) and
// persisted to localStorage. The "Item" column is never hideable.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "market.insightsHiddenCols";

/** Hideable screener columns, in display order, with their picker labels. */
export const HIDEABLE_INSIGHTS_COLUMNS: { key: string; label: string }[] = [
    { key: "volume", label: "Volume" },
    { key: "median", label: "Median/unit" },
    { key: "volatility", label: "Volatility" },
    { key: "trend", label: "Trend" },
    { key: "sellThrough", label: "Sell-through" },
    { key: "timeToSell", label: "Time to sell" },
    { key: "demand", label: "Demand" },
    { key: "liquidity", label: "Liquidity" },
    { key: "deal", label: "Deal" },
    { key: "concentration", label: "Sellers" },
    { key: "delivery", label: "Delivery +" },
    { key: "confidence", label: "Confidence" },
    { key: "lastSale", label: "Last sale" },
];

function load(): string[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === "string");
        }
    } catch {
        /* localStorage unavailable / malformed — fall back to showing everything */
    }
    return [];
}

let current: string[] = load();
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

function commit(next: string[]): void {
    current = next;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
        /* ignore persistence failures */
    }
    listeners.forEach((l) => l());
}

/** Toggle a single column's visibility. */
export function toggleInsightsColumn(key: string): void {
    commit(current.includes(key) ? current.filter((k) => k !== key) : [...current, key]);
}

/** Reset to showing every column. */
export function showAllInsightsColumns(): void {
    if (current.length) commit([]);
}

/** Read the set of hidden column keys, subscribing to changes. */
export function useInsightsHiddenColumns(): string[] {
    return useSyncExternalStore(
        subscribe,
        () => current,
        () => current,
    );
}

// Persisted column-visibility for the Market Insights screener. The screener has
// many columns; this lets users hide the ones they don't care about (the wide
// table then needs less horizontal scrolling). State is a set of hidden column
// keys kept in a tiny module-level store (mirroring `useMarketWindow`) and
// persisted to localStorage. The "Item" column is never hideable.

import { useSyncExternalStore } from "react";
import { writeIfConsented } from "@/lib/consent";

// v2 bumped when `rarity` was added as a default-hidden column; the migration in
// `load()` folds any legacy (v1) hidden set in and forces rarity off by default.
const STORAGE_KEY = "market.insightsHiddenCols.v2";
const LEGACY_STORAGE_KEY = "market.insightsHiddenCols";
// Columns hidden until the user opts in via the Columns picker.
const DEFAULT_HIDDEN = ["rarity"];

/** Hideable screener columns, in display order, with their picker labels. */
export const HIDEABLE_INSIGHTS_COLUMNS: { key: string; label: string }[] = [
    { key: "rarity", label: "Rarity" },
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

function parseHidden(raw: string | null): string[] | null {
    if (!raw) return null;
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : null;
    } catch {
        return null;
    }
}

function load(): string[] {
    try {
        const v2 = parseHidden(localStorage.getItem(STORAGE_KEY));
        if (v2) return v2;
        // Migrate: keep any legacy hidden columns, but force the new opt-in ones off.
        const legacy = parseHidden(localStorage.getItem(LEGACY_STORAGE_KEY)) ?? [];
        return Array.from(new Set([...legacy, ...DEFAULT_HIDDEN]));
    } catch {
        /* localStorage unavailable / malformed — fall back to the default-hidden set */
    }
    return [...DEFAULT_HIDDEN];
}

let current: string[] = load();
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

function commit(next: string[]): void {
    current = next;
    writeIfConsented(STORAGE_KEY, JSON.stringify(next));
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

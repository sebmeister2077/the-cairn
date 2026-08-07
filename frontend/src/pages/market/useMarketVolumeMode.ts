// Shared "volume mode" selection for the Market Insights screener — whether the
// Volume column and range filter measure gears (money that changed hands,
// "price") or units (quantity sold, "unit"). Kept in a tiny module-level store
// mirroring `useMarketWindow` / `useMarketPriceMode`, and persisted to
// localStorage so the choice survives reloads.

import { useSyncExternalStore } from "react";
import { writeIfConsented } from "@/lib/consent";
import type { InsightsVolumeMode } from "./useFilteredInsights";

const STORAGE_KEY = "market.volumeMode";
const VALID = new Set<InsightsVolumeMode>(["price", "unit"]);

function load(): InsightsVolumeMode {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v && VALID.has(v as InsightsVolumeMode)) return v as InsightsVolumeMode;
    } catch {
        /* localStorage unavailable — fall back to the default */
    }
    return "price";
}

let current: InsightsVolumeMode = load();
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

/** Update the shared volume mode and notify subscribers. */
export function setMarketVolumeMode(mode: InsightsVolumeMode): void {
    if (mode === current) return;
    current = mode;
    writeIfConsented(STORAGE_KEY, mode);
    listeners.forEach((l) => l());
}

/** Read (and set) the shared Insights volume mode, persisted across reloads. */
export function useMarketVolumeMode(): [InsightsVolumeMode, (mode: InsightsVolumeMode) => void] {
    const mode = useSyncExternalStore(
        subscribe,
        () => current,
        () => current,
    );
    return [mode, setMarketVolumeMode];
}

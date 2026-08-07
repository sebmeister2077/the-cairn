// Shared, persisted filter state for the Item Search page. Mirrors the tiny
// module-level store used by `useMarketWindow`: keeping the search/category/sort
// selection outside per-page React state means it survives navigating away and
// back (and, via localStorage, a page reload) — matching how the Listings page
// remembers its filters.

import { useSyncExternalStore } from "react";
import { writeIfConsented } from "@/lib/consent";

export type ItemSort = "gears" | "sold" | "listings" | "name";

export interface ItemSearchState {
    q: string;
    /** Category value, or the `ALL_CATEGORIES` sentinel for "no category". */
    category: string;
    sort: ItemSort;
}

// Sentinel for "no category" — base-ui Select can't hold an empty-string value.
export const ALL_CATEGORIES = "__all__";

export const DEFAULT_ITEM_SEARCH: ItemSearchState = {
    q: "",
    category: ALL_CATEGORIES,
    sort: "gears",
};

const STORAGE_KEY = "market.itemSearch";
const VALID_SORTS = new Set<ItemSort>(["gears", "sold", "listings", "name"]);

function load(): ItemSearchState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<ItemSearchState>;
            return {
                q: typeof parsed.q === "string" ? parsed.q : DEFAULT_ITEM_SEARCH.q,
                category:
                    typeof parsed.category === "string" ? parsed.category : DEFAULT_ITEM_SEARCH.category,
                sort: VALID_SORTS.has(parsed.sort as ItemSort)
                    ? (parsed.sort as ItemSort)
                    : DEFAULT_ITEM_SEARCH.sort,
            };
        }
    } catch {
        /* localStorage unavailable / malformed — fall back to defaults */
    }
    return { ...DEFAULT_ITEM_SEARCH };
}

let current: ItemSearchState = load();
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

function commit(next: ItemSearchState): void {
    current = next;
    writeIfConsented(STORAGE_KEY, JSON.stringify(next));
    listeners.forEach((l) => l());
}

/** Merge a partial update into the shared item-search state. */
export function patchItemSearch(patch: Partial<ItemSearchState>): void {
    commit({ ...current, ...patch });
}

/** Reset the item-search state back to its defaults. */
export function resetItemSearch(): void {
    commit({ ...DEFAULT_ITEM_SEARCH });
}

/** Whether the given state equals the defaults (so a reset would be a no-op). */
export function isDefaultItemSearch(s: ItemSearchState): boolean {
    return (
        s.q === DEFAULT_ITEM_SEARCH.q &&
        s.category === DEFAULT_ITEM_SEARCH.category &&
        s.sort === DEFAULT_ITEM_SEARCH.sort
    );
}

/** Read the shared item-search state; re-renders on any change. */
export function useItemSearch(): ItemSearchState {
    return useSyncExternalStore(
        subscribe,
        () => current,
        () => current,
    );
}

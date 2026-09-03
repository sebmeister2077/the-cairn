// Shared, persisted filter state for the Player Search page. Mirrors the tiny
// module-level store used by `useItemSearch`: keeping the query/role/sort
// selection outside per-page React state means it survives navigating away and
// back (and, via localStorage, a page reload).

import { useSyncExternalStore } from "react";
import { writeIfConsented } from "@/lib/consent";

export type PlayerSort = "revenue" | "spent" | "listed" | "sold" | "bought" | "activity" | "name";
/** Which side of the market to keep. `all` keeps everyone. */
export type PlayerRole = "all" | "seller" | "buyer" | "both";

export interface PlayerSearchState {
    q: string;
    role: PlayerRole;
    sort: PlayerSort;
}

export const DEFAULT_PLAYER_SEARCH: PlayerSearchState = {
    q: "",
    role: "all",
    sort: "revenue",
};

const STORAGE_KEY = "market.playerSearch";
const VALID_SORTS = new Set<PlayerSort>([
    "revenue",
    "spent",
    "listed",
    "sold",
    "bought",
    "activity",
    "name",
]);
const VALID_ROLES = new Set<PlayerRole>(["all", "seller", "buyer", "both"]);

function load(): PlayerSearchState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<PlayerSearchState>;
            return {
                q: typeof parsed.q === "string" ? parsed.q : DEFAULT_PLAYER_SEARCH.q,
                role: VALID_ROLES.has(parsed.role as PlayerRole)
                    ? (parsed.role as PlayerRole)
                    : DEFAULT_PLAYER_SEARCH.role,
                sort: VALID_SORTS.has(parsed.sort as PlayerSort)
                    ? (parsed.sort as PlayerSort)
                    : DEFAULT_PLAYER_SEARCH.sort,
            };
        }
    } catch {
        /* localStorage unavailable / malformed — fall back to defaults */
    }
    return { ...DEFAULT_PLAYER_SEARCH };
}

let current: PlayerSearchState = load();
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

function commit(next: PlayerSearchState): void {
    current = next;
    writeIfConsented(STORAGE_KEY, JSON.stringify(next));
    listeners.forEach((l) => l());
}

/** Merge a partial update into the shared player-search state. */
export function patchPlayerSearch(patch: Partial<PlayerSearchState>): void {
    commit({ ...current, ...patch });
}

/** Reset the player-search state back to its defaults. */
export function resetPlayerSearch(): void {
    commit({ ...DEFAULT_PLAYER_SEARCH });
}

/** Whether the given state equals the defaults (so a reset would be a no-op). */
export function isDefaultPlayerSearch(s: PlayerSearchState): boolean {
    return (
        s.q === DEFAULT_PLAYER_SEARCH.q &&
        s.role === DEFAULT_PLAYER_SEARCH.role &&
        s.sort === DEFAULT_PLAYER_SEARCH.sort
    );
}

/** Read the shared player-search state; re-renders on any change. */
export function usePlayerSearch(): PlayerSearchState {
    return useSyncExternalStore(
        subscribe,
        () => current,
        () => current,
    );
}

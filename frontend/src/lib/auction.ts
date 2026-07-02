// Data access for the Auction House explorer.
//
// The market data is produced offline by `backend/process_auction_data.py`
// and published as static JSON under `public/auction/`. We fetch it at
// runtime (kept out of the JS bundle) and cache it via TanStack Query.
// Swapping to an R2/CDN origin later is a one-line change to `AUCTION_BASE`.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
    AuctionListing,
    AuctionSummary,
    ItemCatalog,
} from "@/models/auction";

const AUCTION_BASE = `${import.meta.env.BASE_URL}auction`;

async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${AUCTION_BASE}/${path}`, { signal });
    if (!res.ok) {
        throw new Error(`Failed to load ${path}: ${res.status}`);
    }
    return (await res.json()) as T;
}

// Market data is static per deploy/refresh — cache aggressively.
const STATIC_QUERY = {
    staleTime: 1000 * 60 * 60, // 1h
    gcTime: 1000 * 60 * 60 * 24,
    refetchOnWindowFocus: false,
    meta: { persist: true },
} as const;

export function useAuctionListings() {
    return useQuery({
        queryKey: ["auction", "listings"],
        queryFn: async ({ signal }) => {
            const data = await fetchJson<AuctionListing[]>("listings.json", signal);
            refreshMarketReferences(data);
            return data;
        },
        ...STATIC_QUERY,
    });
}

export function useAuctionSummary(options?: { enabled?: boolean }) {
    return useQuery({
        queryKey: ["auction", "summary"],
        queryFn: ({ signal }) => fetchJson<AuctionSummary>("summary.json", signal),
        enabled: options?.enabled ?? true,
        ...STATIC_QUERY,
    });
}

export function useItemCatalog() {
    return useQuery({
        queryKey: ["auction", "items"],
        queryFn: ({ signal }) => fetchJson<ItemCatalog>("items.json", signal),
        ...STATIC_QUERY,
    });
}

/** Format a Rusty Gears amount for display. */
export function formatGears(n: number): string {
    return `${Math.round(n).toLocaleString()}⚙`;
}

// --------------------------------------------------------------------------- //
// Market reference clocks
// --------------------------------------------------------------------------- //
// The dataset is a static snapshot, so two reference points are derived once
// per load and cached module-side (cheap to read from the per-row badge):
//
//  * currentGameHours — an auction is posted at ~the current in-game moment, so
//    the highest `postedTotalHours` across all listings is our best estimate of
//    "now" in-game. Only ever moves forward.
//  * latestObservedUtc — every capture pass stamps all auctions still on the
//    board with the same `lastObservedUtc`, so the maximum value marks the most
//    recent sweep of the live Auction House. A listing whose last observation
//    predates it dropped off the board (sold/expired/removed) and is no longer
//    visible in-game.

let cachedCurrentGameHours = 0;
let cachedLatestObservedUtc = "";

/**
 * Recompute the cached market reference clocks from a listings array: the
 * in-game "now" (highest posted hours) and the latest capture-sweep timestamp
 * (highest `lastObservedUtc`). Called whenever fresh listings load so the
 * references stay current. Returns the current in-game hours estimate.
 */
export function refreshMarketReferences(listings: AuctionListing[]): number {
    let maxHours = cachedCurrentGameHours;
    let maxObserved = cachedLatestObservedUtc;
    for (const l of listings) {
        const posted = l.postedTotalHours;
        if (posted != null && posted > maxHours) maxHours = posted;
        const observed = l.lastObservedUtc;
        if (observed != null && observed > maxObserved) maxObserved = observed;
    }
    cachedCurrentGameHours = maxHours;
    cachedLatestObservedUtc = maxObserved;
    return maxHours;
}

/** Best estimate of the current in-game total hours (0 when unknown). */
export function getCurrentGameHours(): number {
    return cachedCurrentGameHours;
}

/**
 * Timestamp of the most recent capture sweep of the live Auction House
 * (`""` when unknown). A listing observed at/after this was still on the board
 * in the latest sweep; an earlier one has since dropped off.
 */
export function getLatestObservedUtc(): string {
    return cachedLatestObservedUtc;
}

/**
 * React hook returning the current in-game clock, derived from the full
 * listings dataset. Reads the shared `["auction","listings"]` query (no extra
 * fetch) so the reference clocks are refreshed even when the data was restored
 * from a persisted cache rather than a fresh network load. Computed over the
 * complete dataset — never a filtered subset — so the newest posting and the
 * latest sweep are never missed.
 */
export function useCurrentGameHours(): number {
    const { data } = useAuctionListings();
    return useMemo(
        () => (data ? refreshMarketReferences(data) : getCurrentGameHours()),
        [data],
    );
}

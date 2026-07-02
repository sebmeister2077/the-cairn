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
let cachedLatestSweepStartMs = 0;

// A single capture sweep stamps every still-listed auction with ~the same
// `lastObservedUtc`, but writing hundreds of rows takes a few seconds, so the
// timestamps within one sweep are close but not identical. Consecutive stamps
// that fall within this window belong to the same sweep; a larger gap marks the
// boundary to an earlier capture pass (which are minutes/hours apart). This lets
// us treat a whole sweep — not just the single newest row — as "still on board".
const SWEEP_GAP_MS = 10 * 60 * 1000; // 10 minutes

/** Earliest observation timestamp (epoch ms) that still belongs to the most
 * recent capture sweep, derived by walking distinct timestamps newest-first and
 * stopping at the first gap larger than a single sweep's write span. */
function computeLatestSweepStartMs(observedMs: number[]): number {
    if (!observedMs.length) return cachedLatestSweepStartMs;
    const distinct = Array.from(new Set(observedMs)).sort((a, b) => b - a);
    let start = distinct[0];
    for (let i = 1; i < distinct.length; i++) {
        if (start - distinct[i] <= SWEEP_GAP_MS) {
            start = distinct[i]; // still within the latest sweep
        } else {
            break; // gap → boundary to an earlier capture pass
        }
    }
    return start;
}

/**
 * Recompute the cached market reference clocks from a listings array: the
 * in-game "now" (highest posted hours) and the most recent capture sweep (its
 * newest `lastObservedUtc` plus the start of that sweep's cluster). Called
 * whenever fresh listings load so the references stay current. Returns the
 * current in-game hours estimate.
 */
export function refreshMarketReferences(listings: AuctionListing[]): number {
    let maxHours = cachedCurrentGameHours;
    let maxObserved = cachedLatestObservedUtc;
    const observedMs: number[] = [];
    for (const l of listings) {
        const posted = l.postedTotalHours;
        if (posted != null && posted > maxHours) maxHours = posted;
        const observed = l.lastObservedUtc;
        if (observed != null) {
            if (observed > maxObserved) maxObserved = observed;
            const ms = Date.parse(observed);
            if (!Number.isNaN(ms)) observedMs.push(ms);
        }
    }
    cachedCurrentGameHours = maxHours;
    cachedLatestObservedUtc = maxObserved;
    cachedLatestSweepStartMs = computeLatestSweepStartMs(observedMs);
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

/** Start of the most recent capture sweep (epoch ms; 0 when unknown). Listings
 * observed at/after this were present in the latest sweep of the live board. */
export function getLatestSweepStartMs(): number {
    return cachedLatestSweepStartMs;
}

/**
 * Derived, display-level status of a listing — the single source of truth
 * shared by the status badge and the listings filter so they never disagree.
 *
 *  - "sold"        — a sale was recorded.
 *  - "expired"     — a terminal non-sale verdict (Expired) was recorded.
 *  - "active"      — last seen Active, present in the latest sweep and not due.
 *  - "removed"     — last seen Active but dropped out of the latest sweep or its
 *                    listing duration has elapsed, so it's no longer on the board.
 *  - "unconfirmed" — last seen Active with no sweep/clock reference to decide
 *                    (rendered as "Active?").
 *
 * `currentGameHours` defaults to the module-cached clock so callers that don't
 * thread it still get a best-effort result.
 */
export type ListingStatus = "sold" | "expired" | "active" | "removed" | "unconfirmed";

export function deriveListingStatus(
    listing: AuctionListing,
    currentGameHours?: number,
): ListingStatus {
    if (listing.sold) return "sold";
    // Fall back to the state when older data predates the verdictObserved field:
    // a terminal state (Expired) is inherently a recorded verdict.
    const verdictObserved = listing.verdictObserved ?? listing.state !== "Active";
    if (!verdictObserved) {
        // Last seen "Active", but that alone doesn't mean it's still listed. Two
        // signals prove it's gone: its duration has elapsed, or it fell out of
        // the most recent capture sweep of the live board (not observed since).
        const now = currentGameHours ?? getCurrentGameHours();
        const expired =
            listing.expireTotalHours != null && now > 0 && listing.expireTotalHours < now;
        const sweepStartMs = getLatestSweepStartMs();
        const lastMs = listing.lastObservedUtc ? Date.parse(listing.lastObservedUtc) : NaN;
        const observedInLatestSweep =
            sweepStartMs > 0 && !Number.isNaN(lastMs) ? lastMs >= sweepStartMs : null;
        if (observedInLatestSweep === true && !expired) return "active";
        if (observedInLatestSweep === false || expired) return "removed";
        return "unconfirmed";
    }
    return listing.state === "Expired" ? "expired" : "active";
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

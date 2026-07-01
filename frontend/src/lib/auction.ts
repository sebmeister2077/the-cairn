// Data access for the Auction House explorer.
//
// The market data is produced offline by `backend/process_auction_data.py`
// and published as static JSON under `public/auction/`. We fetch it at
// runtime (kept out of the JS bundle) and cache it via TanStack Query.
// Swapping to an R2/CDN origin later is a one-line change to `AUCTION_BASE`.

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
        queryFn: ({ signal }) => fetchJson<AuctionListing[]>("listings.json", signal),
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

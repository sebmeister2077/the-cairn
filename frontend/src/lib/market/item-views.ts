// Per-item page-view counts for the Item Search "Most views" sort.
//
// Aggregating all page-view telemetry server-side is slow, so the result is
// kept in its own localStorage entry (independent of the global query
// persister, which only persists for signed-in users) and treated as fresh for
// a week. It's only fetched when the caller enables it, i.e. when the user
// actually picks the "Most views" sort.

import { useQuery } from "@tanstack/react-query";
import { API_BASE, handleResponse } from "@/lib/helpers/api";
import { writeIfConsented } from "@/lib/helpers/consent";
import { DAY_MS, WEEK_MS } from "@/lib/constants/time";

const STORAGE_KEY = "market.itemViews";

export interface ItemViews {
    generatedAt: string;
    /** Item id (as string) → all-time view count. Unviewed items are absent. */
    views: Record<string, number>;
}

interface StoredItemViews {
    fetchedAt: number;
    data: ItemViews;
}

function readStored(): StoredItemViews | undefined {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return undefined;
        const parsed = JSON.parse(raw) as StoredItemViews;
        if (typeof parsed?.fetchedAt !== "number" || typeof parsed.data?.views !== "object") {
            return undefined;
        }
        return parsed;
    } catch {
        return undefined;
    }
}

async function fetchItemViews(signal?: AbortSignal): Promise<ItemViews> {
    const res = await fetch(`${API_BASE}/usage/item-views`, { signal });
    const data = (await (await handleResponse(res)).json()) as ItemViews;
    const stored: StoredItemViews = { fetchedAt: Date.now(), data };
    writeIfConsented(STORAGE_KEY, JSON.stringify(stored));
    return data;
}

export function useItemViews(options?: { enabled?: boolean }) {
    return useQuery({
        queryKey: ["market", "itemViews"],
        queryFn: ({ signal }) => fetchItemViews(signal),
        enabled: options?.enabled ?? true,
        // Seed from localStorage; TanStack refetches once it's older than a week.
        initialData: () => readStored()?.data,
        initialDataUpdatedAt: () => readStored()?.fetchedAt,
        staleTime: WEEK_MS,
        gcTime: 3 * WEEK_MS,
        refetchOnWindowFocus: false,
    });
}

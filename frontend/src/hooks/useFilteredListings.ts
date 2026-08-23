import { useMemo } from "react";
import type { AuctionListing } from "@/models/auction";
import { deriveListingStatus, getLatestSweepStartMs } from "@/lib/auction";
import type { AuctionFilters } from "@/store/slices/auctionFilters";

/** Apply the current filter/sort state to the raw listings array. The
 * `isAdmin` flag gates admin-only filters (e.g. `unpickedExpiredOnly`). */
export function filterListings(
    listings: AuctionListing[],
    f: AuctionFilters,
    isAdmin = false,
): AuctionListing[] {
    const q = f.q.trim().toLowerCase();
    const priceMin = f.priceMin === "" ? null : Number(f.priceMin);
    const priceMax = f.priceMax === "" ? null : Number(f.priceMax);
    const excluded = new Set(
        (f.excludePlayers ?? "")
            .split(",")
            .map((n) => n.trim().toLowerCase())
            .filter(Boolean),
    );

    // Earliest observation timestamp still belonging to the most recent capture
    // sweep; a listing observed at/after this is still on the live board.
    const sweepStartMs = getLatestSweepStartMs();

    const rows = listings.filter((l) => {
        if (f.excludeSpam && l.spam) return false;
        if (f.excludeExternalTrades && l.externalTrade) return false;
        if (f.category && l.category !== f.category) return false;
        if (f.deliveredOnly && !l.delivered) return false;
        // Admin-only: expired/cancelled listings the seller hasn't retrieved yet
        // (still present in the latest sweep) — buyable due to a game bug.
        if (isAdmin && f.unpickedExpiredOnly) {
            const expiredOrCancelled = l.state === "Expired" || l.cancelled === true;
            const lastMs = l.lastObservedUtc ? Date.parse(l.lastObservedUtc) : NaN;
            const stillOnBoard =
                sweepStartMs > 0 && !Number.isNaN(lastMs) && lastMs >= sweepStartMs;
            if (!expiredOrCancelled || !stillOnBoard) return false;
        }
        // Match against the derived, display-level status so the filter agrees
        // with the status badge (e.g. an "Active"-state row that dropped off the
        // board renders — and filters — as "Removed", not "Active").
        if (f.state !== "all") {
            const status = deriveListingStatus(l);
            if (f.state === "sold" && status !== "sold") return false;
            // Treat unconfirmed ("Active?") listings as active — they were last
            // seen live and we have no signal that they were removed.
            if (f.state === "active" && status !== "active" && status !== "unconfirmed")
                return false;
            if (f.state === "expired" && status !== "expired") return false;
            if (f.state === "removed" && status !== "removed") return false;
        }
        if (priceMin != null && !Number.isNaN(priceMin) && l.price < priceMin) return false;
        if (priceMax != null && !Number.isNaN(priceMax) && l.price > priceMax) return false;
        if (excluded.size) {
            const seller = l.sellerName?.toLowerCase();
            const buyer = l.buyerName?.toLowerCase();
            if ((seller && excluded.has(seller)) || (buyer && excluded.has(buyer))) return false;
        }
        if (q) {
            const hay =
                `${l.name} ${l.variant ?? ""} ${l.sellerName ?? ""} ${l.buyerName ?? ""}`.toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });

    const dir = f.sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
        let cmp = 0;
        switch (f.sort) {
            case "price":
                cmp = a.price - b.price;
                break;
            case "pricePerUnit":
                cmp = a.pricePerUnit - b.pricePerUnit;
                break;
            case "qty":
                cmp = a.qty - b.qty;
                break;
            case "name":
                cmp = a.name.localeCompare(b.name);
                break;
            case "date":
            default:
                cmp =
                    (a.postedTotalHours ?? 0) - (b.postedTotalHours ?? 0) ||
                    a.auctionId - b.auctionId;
                break;
        }
        return cmp * dir;
    });

    return rows;
}

export function useFilteredListings(
    listings: AuctionListing[] | undefined,
    filters: AuctionFilters,
    isAdmin = false,
): AuctionListing[] {
    return useMemo(
        () => (listings ? filterListings(listings, filters, isAdmin) : []),
        [listings, filters, isAdmin],
    );
}

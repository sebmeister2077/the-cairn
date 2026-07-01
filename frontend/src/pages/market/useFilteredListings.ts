import { useMemo } from "react";
import type { AuctionListing } from "@/models/auction";
import type { AuctionFilters } from "@/store/slices/auctionFilters";

/** Apply the current filter/sort state to the raw listings array. */
export function filterListings(
    listings: AuctionListing[],
    f: AuctionFilters,
): AuctionListing[] {
    const q = f.q.trim().toLowerCase();
    const priceMin = f.priceMin === "" ? null : Number(f.priceMin);
    const priceMax = f.priceMax === "" ? null : Number(f.priceMax);

    const rows = listings.filter((l) => {
        if (f.excludeSpam && l.spam) return false;
        if (f.category && l.category !== f.category) return false;
        if (f.deliveredOnly && !l.delivered) return false;
        if (f.state === "sold" && !l.sold) return false;
        if (f.state === "active" && l.state !== "Active") return false;
        if (f.state === "expired" && l.state !== "Expired") return false;
        if (priceMin != null && !Number.isNaN(priceMin) && l.price < priceMin) return false;
        if (priceMax != null && !Number.isNaN(priceMax) && l.price > priceMax) return false;
        if (q) {
            const hay = `${l.name} ${l.sellerName ?? ""} ${l.buyerName ?? ""}`.toLowerCase();
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
                    (a.lastObservedUtc ?? "").localeCompare(b.lastObservedUtc ?? "") ||
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
): AuctionListing[] {
    return useMemo(
        () => (listings ? filterListings(listings, filters) : []),
        [listings, filters],
    );
}

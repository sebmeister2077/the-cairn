// The "Recent listings" table for an item page, split into its own component so
// its local UI state (the debounced search box, the "sold only" toggle) only
// re-renders this section rather than the whole — expensive — item page on every
// keystroke.

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import type { AuctionListing } from "@/models/auction";
import {
  deriveListingStatus,
  listingMetalType,
  listingLining,
  liquidContainerLabel,
  liquidContainerShort,
} from "@/lib/auction";
import { useDebounced } from "@/hooks/useDebounced";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { VirtualTable, type ListingColumn } from "./VirtualTable";

interface RecentListingsSectionProps {
  /** All listings in the selected window (unsorted); sorted/filtered here. */
  listings: AuctionListing[];
  columns: ListingColumn[];
  /** Estimated current in-game clock, used to derive each listing's status. */
  currentGameHours: number;
  /** Host rock per itemId for merged ore groups, so it's searchable too. */
  hostRockByItemId?: Map<number, string | null> | null;
}

export function RecentListingsSection({
  listings,
  columns,
  currentGameHours,
  hostRockByItemId,
}: RecentListingsSectionProps) {
  const [soldOnly, setSoldOnly] = useState(false);
  const [search, setSearch] = useState("");

  // Newest first by in-game posting time (matches the Game date column),
  // optionally restricted to sold listings only.
  const sortedListings = useMemo(() => {
    const base = soldOnly ? listings.filter((l) => l.sold) : listings;
    return [...base].sort((a, b) => (b.postedTotalHours ?? 0) - (a.postedTotalHours ?? 0));
  }, [listings, soldOnly]);

  // Free-text filter: matches (case-insensitive, all space-separated terms must
  // hit) against every text column shown — item / variant name, seller, buyer,
  // metal, lining, liquid container, host rock, category and status. Debounced so
  // typing doesn't re-filter (and re-render the virtual table) on every keystroke.
  const debouncedSearch = useDebounced(search);
  const visibleListings = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return sortedListings;
    const terms = q.split(/\s+/);
    return sortedListings.filter((l) => {
      const hay = [
        l.name,
        l.variant,
        l.sellerName,
        l.buyerName,
        l.category,
        listingMetalType(l),
        listingLining(l),
        l.liquid ? liquidContainerShort(l.liquid.container) : null,
        l.liquid ? liquidContainerLabel(l.liquid.container) : null,
        hostRockByItemId?.get(l.itemId) ?? null,
        deriveListingStatus(l, currentGameHours),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [sortedListings, debouncedSearch, hostRockByItemId, currentGameHours]);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Recent listings ({visibleListings.length})</h2>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={soldOnly} onCheckedChange={(v) => setSoldOnly(v === true)} />
          Sold only
        </label>
      </div>
      <div className="relative mb-2">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search listings (name, seller, buyer, metal, lining…)"
          aria-label="Search recent listings"
          className="pl-8 pr-8"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <VirtualTable listings={visibleListings} columns={columns} />
    </div>
  );
}

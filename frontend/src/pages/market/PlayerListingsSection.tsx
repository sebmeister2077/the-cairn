// The seller "Listings" table for a player profile, split out from
// [MarketPlayerPage.tsx] so its search/filter state is local. Typing in the
// search box only re-renders this subtree — not the whole (chart-heavy) profile
// page — which keeps input snappy for players with thousands of listings.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  useItemCatalog,
  useCurrentGameHours,
  formatRealTimeToSell,
  listingHasText,
} from "@/lib/auction";
import type { AuctionListing } from "@/models/auction";
import { useDebounced } from "@/hooks/useDebounced";
import {
  VirtualListingsTable,
  formatListingDate,
  formatGameDate,
  ListingStateBadge,
  DeliveryFeeCell,
  CancelledCell,
  ListingNotesCell,
  type ListingColumn,
} from "./VirtualListingsTable";

/** Compact checkbox-popover multi-select for filtering listings by item type. */
function TypeMultiSelect({
  options,
  selected,
  onChange,
}: {
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);

  const summary =
    selected.length === 0
      ? "All types"
      : selected.length === 1
        ? selected[0]
        : `${selected.length} types`;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-9 w-40 justify-between gap-1 font-normal"
          />
        }
      >
        <span className={cn("truncate", selected.length === 0 && "text-muted-foreground")}>
          {summary}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground/70" />
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-52 p-1">
        <div className="max-h-[min(18rem,60vh)] overflow-y-auto">
          {options.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">No types</p>
          ) : (
            options.map((o) => (
              <label
                key={o}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60"
              >
                <Checkbox checked={selected.includes(o)} onCheckedChange={() => toggle(o)} />
                {o}
              </label>
            ))
          )}
        </div>
        {selected.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 h-7 w-full text-xs text-muted-foreground"
            onClick={() => onChange([])}
          >
            Clear
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The seller-side listings for one player: a "Sold only" / "Cancelled only"
 * pair of (mutually exclusive) toggles, a debounced search box, a by-type
 * multi-select, and the virtualized table.
 *
 * @param listings This player's seller listings (already windowed).
 */
export function PlayerListingsSection({ listings }: { listings: AuctionListing[] }) {
  const { data: catalog } = useItemCatalog();
  const currentGameHours = useCurrentGameHours();

  const [soldOnly, setSoldOnly] = useState(false);
  // Mutually exclusive with `soldOnly`: only one of the two can be on.
  const [cancelledOnly, setCancelledOnly] = useState(false);
  const [search, setSearch] = useState("");
  // Debounced copy drives the actual filtering so typing stays responsive on
  // players with many listings.
  const debouncedSearch = useDebounced(search);
  const [types, setTypes] = useState<string[]>([]);

  // The distinct item types (categories) this player has listed, for the type
  // filter's options.
  const typeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const l of listings) if (l.category) set.add(l.category);
    return [...set].sort();
  }, [listings]);

  // Newest first by in-game posting time (matches the Game date column). Applies
  // the "sold only" / "cancelled only" toggles (mutually exclusive), the type
  // filter, and the free-text search (item id, item code, variant, display name,
  // or buyer name).
  const sorted = useMemo(() => {
    let base = listings;
    if (soldOnly) base = base.filter((l) => l.sold);
    else if (cancelledOnly) base = base.filter((l) => l.cancelled === true);
    if (types.length) {
      const typeSet = new Set(types);
      base = base.filter((l) => typeSet.has(l.category));
    }
    const q = debouncedSearch.trim().toLowerCase();
    if (q) {
      base = base.filter((l) => {
        const code = catalog?.[String(l.itemId)]?.code ?? "";
        const hay =
          `${l.itemId} ${code} ${l.variant ?? ""} ${l.name} ${l.buyerName ?? ""}`.toLowerCase();
        return hay.includes(q);
      });
    }
    return [...base].sort((a, b) => (b.postedTotalHours ?? 0) - (a.postedTotalHours ?? 0));
  }, [listings, soldOnly, cancelledOnly, types, debouncedSearch, catalog]);

  // Whether any of this player's sales include written parchments/books, so the
  // "Notes" column only appears when it has something to flag.
  const hasText = useMemo(() => listings.some(listingHasText), [listings]);

  const columns = useMemo<ListingColumn[]>(
    () => [
      {
        key: "item",
        header: "Item",
        width: "minmax(8rem,1fr)",
        cell: (l) => (
          <Link
            to={`/market/items/${l.itemId}`}
            className="hover:underline"
            title={l.variant ? l.name : undefined}
          >
            {l.variant || l.name}
          </Link>
        ),
      },
      {
        key: "price",
        header: "Price",
        width: "6rem",
        align: "right",
        cell: (l) => l.price.toLocaleString(),
      },
      {
        key: "qty",
        header: "Qty",
        width: "3.5rem",
        align: "right",
        cell: (l) => l.qty,
      },
      {
        key: "date",
        header: "Game date",
        width: "6.5rem",
        cell: (l) => (
          <span
            className="text-xs text-muted-foreground"
            title={`Observed ${formatListingDate(l.observedUtc ?? l.lastObservedUtc)}`}
          >
            {formatGameDate(l.postedTotalHours)}
          </span>
        ),
      },
      {
        key: "buyer",
        header: "Buyer",
        width: "minmax(6rem,1fr)",
        cell: (l) =>
          l.sold && l.buyerUid ? (
            <Link
              to={`/market/players/${encodeURIComponent(l.buyerUid)}`}
              className="text-xs hover:underline"
            >
              {l.buyerName ?? "—"}
            </Link>
          ) : (
            <span className="text-xs text-muted-foreground">
              {l.sold ? (l.buyerName ?? "—") : "—"}
            </span>
          ),
      },
      {
        key: "soldIn",
        header: "Sold in",
        width: "minmax(5.5rem,0.9fr)",
        align: "right",
        cell: (l) => (
          <span
            className="text-xs text-muted-foreground"
            title="Real-world time from posting to sale"
          >
            {l.timeToSellHours != null ? formatRealTimeToSell(l.timeToSellHours) : "—"}
          </span>
        ),
      },
      {
        key: "delivery",
        header: "Delivery",
        width: "minmax(4.5rem,0.7fr)",
        align: "right",
        cell: (l) => <DeliveryFeeCell listing={l} />,
      },
      {
        key: "cancelled",
        header: "Cancelled",
        width: "minmax(5rem,0.7fr)",
        cell: (l) => <CancelledCell listing={l} />,
      },
      ...(hasText
        ? [
            {
              key: "notes",
              header: "Notes",
              width: "minmax(4.5rem,0.8fr)",
              cell: (l) => <ListingNotesCell listing={l} />,
            } satisfies ListingColumn,
          ]
        : []),
      {
        key: "status",
        header: "Status",
        width: "5rem",
        cell: (l) => <ListingStateBadge listing={l} currentGameHours={currentGameHours} />,
      },
    ],
    [currentGameHours, hasText],
  );

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          Listings ({sorted.length}
          {sorted.length !== listings.length ? ` of ${listings.length}` : ""})
        </h2>
        <div className="flex items-center gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={soldOnly}
              onCheckedChange={(v) => {
                const checked = v === true;
                setSoldOnly(checked);
                // Sold and Cancelled are opposites — turning one on turns the
                // other off (both may be off).
                if (checked) setCancelledOnly(false);
              }}
            />
            Sold only
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={cancelledOnly}
              onCheckedChange={(v) => {
                const checked = v === true;
                setCancelledOnly(checked);
                if (checked) setSoldOnly(false);
              }}
            />
            Cancelled only
          </label>
        </div>
      </div>
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search item id, code, name, or buyer…"
            className="h-9 pl-8 pr-8"
            aria-label="Search listings"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/70 hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <Label className="sr-only">Type</Label>
          <TypeMultiSelect options={typeOptions} selected={types} onChange={setTypes} />
        </div>
      </div>
      {sorted.length === 0 ? (
        <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
          No listings match your search.
        </p>
      ) : (
        <VirtualListingsTable listings={sorted} columns={columns} />
      )}
    </div>
  );
}

// Virtualized, column-configurable table for Auction House listings. Some
// items / players have hundreds or thousands of listings, so rows are
// windowed with @tanstack/react-virtual to keep the DOM small.

import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Wrench } from "lucide-react";
import type { AuctionListing } from "@/models/auction";
import { deriveListingStatus, listingHasText, listingToolAttributes } from "@/lib/auction";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Status badge for an auction listing, shared across the market pages.
 *
 * "Active" is only shown when the listing is genuinely still on the board: it
 * appeared in the most recent capture sweep of the live Auction House AND its
 * listing duration hasn't elapsed. A listing last seen "Active" that either
 * dropped out of the latest sweep (not observed since) or whose duration is now
 * due is definitely no longer visible in-game, so it renders as "Removed".
 *
 * `currentGameHours` is the estimated current in-game clock (see
 * `useCurrentGameHours`); it defaults to the module-cached value so callers that
 * don't thread it still get a best-effort result.
 */
export function ListingStateBadge({
  listing,
  currentGameHours,
}: {
  listing: AuctionListing;
  currentGameHours?: number;
}) {
  const status = deriveListingStatus(listing, currentGameHours);
  switch (status) {
    case "sold":
      return <Badge className="bg-emerald-600 hover:bg-emerald-600">Sold</Badge>;
    case "active":
      return <Badge variant="outline">Active</Badge>;
    case "removed":
      return (
        <Badge
          variant="secondary"
          className="border border-dashed border-muted-foreground/40"
          title="No longer listed on the Auction House — it dropped out of the latest capture or its listing duration has elapsed"
        >
          Removed
        </Badge>
      );
    case "unconfirmed":
      return (
        <Badge
          variant="secondary"
          className="border border-dashed border-muted-foreground/40"
          title="Final outcome never recorded — this is the last observed state, not a confirmed live listing"
        >
          Active?
        </Badge>
      );
    case "expired":
    default:
      return <Badge variant="outline">{listing.state}</Badge>;
  }
}

export interface ListingColumn {
  key: string;
  header: ReactNode;
  /** CSS grid track size, e.g. "minmax(8rem,1fr)" or "5rem". */
  width: string;
  align?: "left" | "right";
  cell: (l: AuctionListing) => ReactNode;
}

const ROW_HEIGHT = 36;

/**
 * Delivery fee cell for a listing: shows the gears the buyer paid for delivery
 * (e.g. "+3⚙"), or an em dash for pickup listings. Shared across the listing
 * tables so delivery pricing renders consistently.
 */
export function DeliveryFeeCell({ listing }: { listing: AuctionListing }) {
  if (!listing.delivered) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const fee = listing.deliveryFee ?? 0;
  return (
    <span
      className="text-xs tabular-nums text-muted-foreground"
      title="Delivery fee the buyer paid for this listing"
    >
      {fee > 0 ? `+${Math.round(fee).toLocaleString()}⚙` : "Free"}
    </span>
  );
}

/**
 * Cancellation cell for a listing: flags an unsold listing the seller pulled
 * early (see `cancelled` in the data model) so an expired row shows at a glance
 * whether it lapsed naturally or was taken down. Sold rows and naturally expired
 * rows render an em dash so the column stays quiet.
 */
export function CancelledCell({ listing }: { listing: AuctionListing }) {
  if (!listing.cancelled) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <Badge
      variant="secondary"
      className="border border-amber-500/40 text-xs font-normal text-amber-600 dark:text-amber-400"
      title="The seller pulled this listing shortly after posting it — cancelled rather than expired naturally"
    >
      Cancelled
    </Badge>
  );
}

/**
 * Notes cell for a listing: flags parchments/books that carry written content
 * (a story, note, or advert). These are priced for their content rather than as
 * the raw commodity, so they're excluded from fair-price stats but still listed.
 */
export function ListingNotesCell({ listing }: { listing: AuctionListing }) {
  if (!listingHasText(listing)) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <Badge
      variant="secondary"
      className="text-xs font-normal"
      title="This item has written text — excluded from fair-price stats"
    >
      Text
    </Badge>
  );
}

/**
 * Attributes cell for a tool/weapon listing: when the item stack carries
 * something worth seeing (a worn condition, remaining durability, or a
 * modifier/buff), shows a small "Details" button that opens a popover with the
 * decoded attributes. Non-tool listings and pristine tools render an em dash so
 * the column stays quiet. Never dumps the raw attribute JSON.
 */
export function ListingAttributesCell({ listing }: { listing: AuctionListing }) {
  const attrs = listingToolAttributes(listing);
  if (attrs.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex h-6 cursor-pointer items-center gap-1 rounded border border-border/60 px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            title="View this item's condition and modifiers"
          >
            <Wrench className="h-3 w-3" aria-hidden />
            Details
          </button>
        }
      />
      <PopoverContent align="end" className="w-72 max-w-[90vw] p-3">
        <p className="mb-2 text-xs font-medium">Item attributes</p>
        <dl className="space-y-1">
          {attrs.map((a) => (
            <div key={a.label} className="flex items-start justify-between gap-3 text-xs">
              <dt className="shrink-0 text-muted-foreground">{a.label}</dt>
              <dd className="min-w-0 break-words text-right font-medium tabular-nums">{a.value}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

interface VirtualListingsTableProps {
  listings: AuctionListing[];
  columns: ListingColumn[];
  /** Tailwind max-height class for the scroll container. */
  maxHeightClass?: string;
}

/** Format an ISO capture timestamp as a short local date, or "—". */
export function formatListingDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "2-digit", month: "short", day: "numeric" });
}

// In-game calendar for this server: 24 in-game hours per day, 30 days per
// month, 12 months per year. `PostedTotalHours` (carried through as
// `postedTotalHours`) is the total in-game hours since world start at the
// moment the auction was posted, so we can reconstruct the calendar date.
const GAME_HOURS_PER_DAY = 24;
const GAME_DAYS_PER_MONTH = 30;
const GAME_MONTHS_PER_YEAR = 12;
const GAME_DAYS_PER_YEAR = GAME_DAYS_PER_MONTH * GAME_MONTHS_PER_YEAR;

/**
 * Convert an in-game "total hours since world start" value into a display
 * calendar date (`Y{year} M{month} D{day}`), or "—" when unknown. Year, month
 * and day are 1-based to match how the in-game HUD counts them.
 */
export function formatGameDate(totalHours: number | null | undefined): string {
  if (totalHours == null || !Number.isFinite(totalHours) || totalHours <= 0) return "—";
  const totalDays = Math.floor(totalHours / GAME_HOURS_PER_DAY);
  const year = Math.floor(totalDays / GAME_DAYS_PER_YEAR) + 1;
  const dayOfYear = totalDays % GAME_DAYS_PER_YEAR;
  const month = Math.floor(dayOfYear / GAME_DAYS_PER_MONTH) + 1;
  const day = (dayOfYear % GAME_DAYS_PER_MONTH) + 1;
  return `Y${year} M${month} D${day}`;
}

export function VirtualListingsTable({
  listings,
  columns,
  maxHeightClass = "max-h-96",
}: VirtualListingsTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: listings.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const gridTemplate = columns.map((c) => c.width).join(" ");

  return (
    <div className="rounded-md border">
      {/* Header */}
      <div
        className="grid items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {columns.map((c) => (
          <span key={c.key} className={cn("min-w-0", c.align === "right" && "text-right")}>
            {c.header}
          </span>
        ))}
      </div>

      {/* Virtualized body */}
      <div ref={parentRef} className={cn("overflow-auto", maxHeightClass)}>
        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((vr) => {
            const l = listings[vr.index];
            return (
              <div
                key={l.auctionId}
                className="absolute left-0 top-0 grid w-full items-center gap-2 border-b border-border/60 px-3 text-sm"
                style={{
                  height: `${vr.size}px`,
                  transform: `translateY(${vr.start}px)`,
                  gridTemplateColumns: gridTemplate,
                }}
              >
                {columns.map((c) => (
                  <span
                    key={c.key}
                    className={cn(
                      "min-w-0 truncate",
                      c.align === "right" && "text-right tabular-nums",
                    )}
                  >
                    {c.cell(l)}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

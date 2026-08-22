// The buyer-side "Purchases" table for a player profile, split out from
// [MarketPlayerPage.tsx] to keep that page focused on layout rather than the
// listing-table plumbing.

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { formatRealTimeToSell, listingHasText } from "@/lib/auction";
import type { AuctionListing } from "@/models/auction";
import {
  VirtualListingsTable,
  formatListingDate,
  formatGameDate,
  DeliveryFeeCell,
  ListingNotesCell,
  type ListingColumn,
} from "./VirtualListingsTable";

/**
 * The purchases this player made (they are the buyer). Surfaces who they bought
 * *from* rather than a buyer column.
 *
 * @param listings This player's confirmed purchases (already windowed).
 */
export function PlayerPurchasesSection({ listings }: { listings: AuctionListing[] }) {
  // Newest first by in-game posting time.
  const sorted = useMemo(
    () => [...listings].sort((a, b) => (b.postedTotalHours ?? 0) - (a.postedTotalHours ?? 0)),
    [listings],
  );

  // Whether any purchase carries written parchments/books, so the "Notes" column
  // only appears when it has something to flag.
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
        key: "seller",
        header: "From",
        width: "minmax(6rem,1fr)",
        cell: (l) =>
          l.sellerUid ? (
            <Link
              to={`/market/players/${encodeURIComponent(l.sellerUid)}`}
              className="text-xs hover:underline"
            >
              {l.sellerName ?? "—"}
            </Link>
          ) : (
            <span className="text-xs text-muted-foreground">{l.sellerName ?? "—"}</span>
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
    ],
    [hasText],
  );

  return (
    <div>
      <h2 className="font-semibold mb-2">Purchases ({listings.length})</h2>
      {listings.length === 0 ? (
        <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
          No recorded purchases.
        </p>
      ) : (
        <VirtualListingsTable listings={sorted} columns={columns} />
      )}
    </div>
  );
}

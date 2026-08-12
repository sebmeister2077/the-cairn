import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAppSelector } from "@/store/hooks";
import { useAuctionListings, useAuctionCsvUrl, useCurrentGameHours } from "@/lib/auction";
import { MarketFilterBar } from "./MarketFilterBar";
import { useFilteredListings } from "./useFilteredListings";
import {
  formatGameDate,
  formatListingDate,
  ListingStateBadge,
  ListingNotesCell,
} from "./VirtualListingsTable";
const PAGE_SIZE = 100;

export function MarketListingsPage() {
  const { data, isPending, isError } = useAuctionListings();
  const currentGameHours = useCurrentGameHours();
  const filters = useAppSelector((s) => s.auctionFilters);
  const isAdmin = useAppSelector((s) => s.auth.isAdmin);
  const rows = useFilteredListings(data, filters, isAdmin);
  const showAuctionId = isAdmin && filters.showAuctionId;
  // Keep the page in the URL so it survives navigating to an item and back.
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Math.max(0, (Number(searchParams.get("page")) || 1) - 1);
  const setPage = (next: number) => {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next <= 0) p.delete("page");
        else p.set("page", String(next + 1));
        return p;
      },
      { replace: true },
    );
  };
  // The raw CSV is published to the R2 bucket's `auction/` folder alongside the
  // JSON data; the download link points straight at it.
  const csvUrl = useAuctionCsvUrl();

  const categories = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.map((l) => l.category))).sort();
  }, [data]);

  // Reset to first page whenever the filtered result set changes size.
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  if (isPending) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
        <Spinner /> Loading market data…
      </div>
    );
  }
  if (isError || !data) {
    return <p className="text-destructive py-12 text-center">Failed to load auction data.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Auction Listings</h1>
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted-foreground">
            {rows.length.toLocaleString()} of {data.length.toLocaleString()} listings
          </p>
          {csvUrl && (
            <a
              href={csvUrl}
              download="auctions.csv"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <Download />
              Download CSV
            </a>
          )}
        </div>
      </div>

      <MarketFilterBar categories={categories} isAdmin={isAdmin} />

      <div className="rounded-md border overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              {showAuctionId && <TableHead className="text-right">AuctionId</TableHead>}
              <TableHead>Game date</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">/ unit</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Seller</TableHead>
              <TableHead>Buyer</TableHead>
              <TableHead className="text-right">Delivery</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map((l) => (
              <TableRow key={l.auctionId}>
                <TableCell className="font-medium">
                  <Link
                    to={`/market/items/${l.itemId}`}
                    className="hover:underline"
                    title={l.variant ? `${l.name} · ${l.category}` : l.category}
                  >
                    {l.variant || l.name}
                  </Link>
                </TableCell>
                {showAuctionId && (
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {l.auctionId}
                  </TableCell>
                )}
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  <span title={`Observed ${formatListingDate(l.observedUtc ?? l.lastObservedUtc)}`}>
                    {formatGameDate(l.postedTotalHours)}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {l.price.toLocaleString()}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {l.pricePerUnit.toLocaleString()}
                </TableCell>
                <TableCell className="text-right tabular-nums">{l.qty}</TableCell>
                <TableCell>
                  <ListingStateBadge listing={l} currentGameHours={currentGameHours} />
                </TableCell>
                <TableCell className="text-xs truncate max-w-[120px]">
                  {l.sellerUid ? (
                    <Link
                      to={`/market/players/${encodeURIComponent(l.sellerUid)}`}
                      className="hover:underline"
                    >
                      {l.sellerName ?? "—"}
                    </Link>
                  ) : (
                    (l.sellerName ?? "—")
                  )}
                </TableCell>
                <TableCell className="text-xs truncate max-w-[120px]">
                  {l.buyerUid ? (
                    <Link
                      to={`/market/players/${encodeURIComponent(l.buyerUid)}`}
                      className="hover:underline"
                    >
                      {l.buyerName ?? "—"}
                    </Link>
                  ) : (
                    (l.buyerName ?? "—")
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {l.delivered ? (
                    <span title="Delivery fee the buyer paid for this listing">
                      {l.deliveryFee > 0
                        ? `+${Math.round(l.deliveryFee).toLocaleString()}⚙`
                        : "Free"}
                    </span>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  <ListingNotesCell listing={l} />
                </TableCell>
              </TableRow>
            ))}
            {pageRows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={showAuctionId ? 11 : 10}
                  className="text-center text-muted-foreground py-8"
                >
                  No listings match your filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={clampedPage === 0}
            onClick={() => setPage(clampedPage - 1)}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {clampedPage + 1} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={clampedPage >= pageCount - 1}
            onClick={() => setPage(clampedPage + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

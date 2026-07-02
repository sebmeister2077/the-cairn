import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAppSelector } from "@/store/hooks";
import { useAuctionListings } from "@/lib/auction";
import type { AuctionListing } from "@/models/auction";
import { MarketFilterBar } from "./MarketFilterBar";
import { useFilteredListings } from "./useFilteredListings";
import { formatGameDate, formatListingDate } from "./VirtualListingsTable";

const PAGE_SIZE = 100;

function StateBadge({ l }: { l: AuctionListing }) {
  if (l.sold) return <Badge className="bg-emerald-600 hover:bg-emerald-600">Sold</Badge>;
  if (l.state === "Active") return <Badge variant="secondary">Active</Badge>;
  return <Badge variant="outline">Expired</Badge>;
}

export function MarketListingsPage() {
  const { data, isLoading, isError } = useAuctionListings();
  const filters = useAppSelector((s) => s.auctionFilters);
  const rows = useFilteredListings(data, filters);
  const [page, setPage] = useState(0);

  const categories = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.map((l) => l.category))).sort();
  }, [data]);

  // Reset to first page whenever the filtered result set changes size.
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  if (isLoading) {
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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Auction Listings</h1>
        <p className="text-sm text-muted-foreground">
          {rows.length.toLocaleString()} of {data.length.toLocaleString()} listings
        </p>
      </div>

      <MarketFilterBar categories={categories} />

      <div className="rounded-md border overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Game date</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">/ unit</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Seller</TableHead>
              <TableHead>Buyer</TableHead>
              <TableHead className="text-center">Del.</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map((l) => (
              <TableRow key={l.auctionId}>
                <TableCell className="font-medium">
                  <Link
                    to={`/market/items/${l.itemId}`}
                    className="hover:underline"
                    title={l.category}
                  >
                    {l.name}
                  </Link>
                </TableCell>
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
                  <StateBadge l={l} />
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
                <TableCell className="text-center">{l.delivered ? "✓" : ""}</TableCell>
              </TableRow>
            ))}
            {pageRows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
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

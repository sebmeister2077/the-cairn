import { useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { StatCard } from "@/components/usage/StatCard";
import { useAuctionListings, useAuctionSummary, formatGears } from "@/lib/auction";
import {
  VirtualListingsTable,
  formatListingDate,
  formatGameDate,
  type ListingColumn,
} from "./VirtualListingsTable";

/** Build a price-per-unit histogram plus a fitted log-normal density curve. */
function buildHistogram(prices: number[], bins = 24) {
  if (prices.length === 0) return { bars: [], median: 0 };
  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const span = max - min || 1;
  const width = span / bins;

  const counts = new Array(bins).fill(0);
  for (const p of prices) {
    const idx = Math.min(bins - 1, Math.floor((p - min) / width));
    counts[idx] += 1;
  }

  // Log-normal fit on positive prices.
  const logs = prices.filter((p) => p > 0).map((p) => Math.log(p));
  const mu = logs.reduce((s, x) => s + x, 0) / (logs.length || 1);
  const variance = logs.reduce((s, x) => s + (x - mu) ** 2, 0) / (logs.length || 1);
  const sigma = Math.sqrt(variance) || 1;
  const total = prices.length;

  const bars = counts.map((count, i) => {
    const lo = min + i * width;
    const center = lo + width / 2;
    // Log-normal PDF scaled to expected count in this bin.
    const pdf =
      center > 0
        ? (1 / (center * sigma * Math.sqrt(2 * Math.PI))) *
          Math.exp(-((Math.log(center) - mu) ** 2) / (2 * sigma * sigma))
        : 0;
    return {
      bucket: Math.round(center),
      count,
      fit: Math.round(pdf * width * total),
    };
  });
  return { bars, median };
}

export function MarketItemPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const id = Number(itemId);
  const listingsQ = useAuctionListings();
  const summaryQ = useAuctionSummary();

  const itemListings = useMemo(
    () => (listingsQ.data ?? []).filter((l) => l.itemId === id),
    [listingsQ.data, id],
  );
  const stat = useMemo(
    () => summaryQ.data?.itemStats.find((s) => s.itemId === id),
    [summaryQ.data, id],
  );

  const soldPpu = useMemo(
    () => itemListings.filter((l) => l.sold).map((l) => l.pricePerUnit),
    [itemListings],
  );
  const hist = useMemo(() => buildHistogram(soldPpu), [soldPpu]);

  // Some items are only ever sold as full stacks, so the per-unit median can
  // round down to 0 (e.g. 1 gear for a stack of 64). In that case fall back to
  // the median *stack* price so the "Fair price" card stays meaningful.
  const medianStackPrice = useMemo(() => {
    const prices = itemListings
      .filter((l) => l.sold)
      .map((l) => l.price)
      .sort((a, b) => a - b);
    return prices.length ? prices[Math.floor(prices.length / 2)] : 0;
  }, [itemListings]);

  // Newest first by in-game posting time (matches the Game date column).
  const sortedListings = useMemo(
    () =>
      [...itemListings].sort((a, b) => (b.postedTotalHours ?? 0) - (a.postedTotalHours ?? 0)),
    [itemListings],
  );

  const columns = useMemo<ListingColumn[]>(
    () => [
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
        cell: (l) => `×${l.qty}`,
      },
      {
        key: "seller",
        header: "Seller",
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
        key: "status",
        header: "Status",
        width: "5rem",
        cell: (l) => (
          <span className="text-xs text-muted-foreground">
            {l.sold ? "sold" : l.state.toLowerCase()}
          </span>
        ),
      },
    ],
    [],
  );

  if (listingsQ.isLoading || summaryQ.isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
        <Spinner /> Loading…
      </div>
    );
  }
  if (!stat || itemListings.length === 0) {
    return (
      <div className="py-12 text-center space-y-2">
        <p className="text-muted-foreground">No data for this item.</p>
        <Link to="/market/listings" className="text-primary hover:underline">
          Back to listings
        </Link>
      </div>
    );
  }

  const ps = stat.priceStats;
  const perUnitUseful = ps != null && ps.median >= 1;

  return (
    <div className="space-y-5">
      <div>
        <Link to="/market/listings" className="text-sm text-primary hover:underline">
          ← Listings
        </Link>
        <h1 className="text-2xl font-semibold">{stat.name}</h1>
        <p className="text-sm text-muted-foreground">
          {stat.category} · #{stat.itemId}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label={perUnitUseful ? "Fair price / unit" : "Fair price / stack"}
          value={
            perUnitUseful
              ? formatGears(ps!.median)
              : medianStackPrice
                ? formatGears(medianStackPrice)
                : "—"
          }
          hint={
            perUnitUseful
              ? "Median of sold listings"
              : "Sold in stacks — median sold stack price"
          }
        />
        <StatCard label="Units sold" value={stat.unitsSold} />
        <StatCard
          label="Sell-through"
          value={stat.sellThrough != null ? `${(stat.sellThrough * 100).toFixed(0)}%` : "—"}
        />
        <StatCard
          label="Median time to sell"
          value={stat.medianTimeToSell != null ? `${Math.round(stat.medianTimeToSell)} h` : "—"}
        />
      </div>

      {ps && (
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold">Price-per-unit distribution (sold)</h2>
              <span className="text-xs text-muted-foreground">
                p25 {ps.p25} · median {ps.median} · p75 {ps.p75}
              </span>
            </div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={hist.bars}>
                  <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#6366f1" name="Listings" radius={[2, 2, 0, 0]} />
                  <Line
                    dataKey="fit"
                    stroke="#f59e0b"
                    dot={false}
                    strokeWidth={2}
                    name="Log-normal fit"
                  />
                  <ReferenceLine
                    x={Math.round(hist.median)}
                    stroke="#10b981"
                    strokeDasharray="4 4"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Green line = fair price (median). The amber curve is a fitted log-normal, the typical
              shape of auction prices.
            </p>
          </CardContent>
        </Card>
      )}

      <div>
        <h2 className="text-lg font-semibold mb-2">Recent listings ({itemListings.length})</h2>
        <VirtualListingsTable listings={sortedListings} columns={columns} />
      </div>
    </div>
  );
}

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
import type { PriceTrend } from "@/models/auction";
import {
  VirtualListingsTable,
  formatListingDate,
  formatGameDate,
  type ListingColumn,
} from "./VirtualListingsTable";

/** Linear-interpolated percentile over an already-sorted ascending array. */
function percentileSorted(sorted: number[], p: number) {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Build a price histogram plus a fitted log-normal density curve. */
function buildHistogram(prices: number[], bins = 24) {
  if (prices.length === 0) return { bars: [], median: 0, p25: 0, p75: 0, medianBucket: 0 };
  const sorted = [...prices].sort((a, b) => a - b);
  const median = percentileSorted(sorted, 0.5);
  const p25 = percentileSorted(sorted, 0.25);
  const p75 = percentileSorted(sorted, 0.75);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const span = max - min || 1;
  const width = span / bins;

  // Pick a label precision fine enough that adjacent buckets don't round to
  // the same value. Without this, sub-gear per-unit prices collapsed every
  // bucket to "0" or "1", producing repeated x-axis labels on bars of
  // different heights.
  const decimals = width >= 1 ? 0 : Math.min(3, Math.max(1, Math.ceil(-Math.log10(width))));
  const round = (v: number) => Number(v.toFixed(decimals));

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
      bucket: round(center),
      count,
      fit: Math.round(pdf * width * total),
    };
  });
  // Snap the fair-price marker to the bucket that actually contains the
  // median so the reference line lands on a real category on the axis.
  const medianIdx = Math.min(bins - 1, Math.max(0, Math.floor((median - min) / width)));
  const medianBucket = bars[medianIdx]?.bucket ?? round(median);
  return { bars, median, p25, p75, medianBucket };
}

/** Small colored pill showing whether the recent price is trending up/down. */
function TrendBadge({ trend }: { trend: PriceTrend }) {
  const { direction, changePct } = trend;
  const up = direction === "up";
  const down = direction === "down";
  const cls = up
    ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30"
    : down
      ? "bg-red-500/15 text-red-600 border-red-500/30"
      : "bg-muted text-muted-foreground border-input";
  const arrow = up ? "▲" : down ? "▼" : "→";
  const sign = changePct > 0 ? "+" : "";
  const label = direction === "flat" ? "Stable price" : `${sign}${changePct}% recently`;
  const title =
    `Recent ${trend.recentCount} sales: median ${trend.recentMedian}/unit · ` +
    `older ${trend.olderCount} sales: median ${trend.olderMedian}/unit.`;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}
      title={title}
    >
      <span aria-hidden>{arrow}</span>
      {label}
    </span>
  );
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

  // Some items are only ever sold as full stacks, so the per-unit median can
  // round down to below 1 gear (e.g. 28 gears for a stack of 32). In that case
  // we treat the item as "stack-priced": the "Fair price" card and the chart
  // below both switch to whole-stack prices so the numbers stay meaningful and
  // the histogram shows a real spread instead of everything collapsing onto
  // 0 / 1 per-unit buckets.
  const soldStackPrices = useMemo(
    () => itemListings.filter((l) => l.sold).map((l) => l.price),
    [itemListings],
  );
  // `priceStats.median` is the per-unit median computed server-side. When it's
  // below 1 gear the per-unit view isn't useful, so we fall back to stacks.
  const perUnitUseful = (stat?.priceStats?.median ?? 0) >= 1;
  const chartPrices = perUnitUseful ? soldPpu : soldStackPrices;
  const hist = useMemo(() => buildHistogram(chartPrices), [chartPrices]);

  const medianStackPrice = useMemo(() => {
    const prices = [...soldStackPrices].sort((a, b) => a - b);
    return prices.length ? prices[Math.floor(prices.length / 2)] : 0;
  }, [soldStackPrices]);

  // Newest first by in-game posting time (matches the Game date column).
  const sortedListings = useMemo(
    () => [...itemListings].sort((a, b) => (b.postedTotalHours ?? 0) - (a.postedTotalHours ?? 0)),
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

  return (
    <div className="space-y-5">
      <div>
        <Link to="/market/listings" className="text-sm text-primary hover:underline">
          ← Listings
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{stat.name}</h1>
          {stat.trend && <TrendBadge trend={stat.trend} />}
        </div>
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
            perUnitUseful ? "Median of sold listings" : "Sold in stacks — median sold stack price"
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
              <h2 className="font-semibold">
                {perUnitUseful
                  ? "Price-per-unit distribution (sold)"
                  : "Price-per-stack distribution (sold)"}
              </h2>
              <span className="text-xs text-muted-foreground">
                p25 {hist.p25.toLocaleString()} · median {hist.median.toLocaleString()} · p75{" "}
                {hist.p75.toLocaleString()}
              </span>
            </div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={hist.bars} margin={{ top: 4, right: 8, bottom: 18, left: 4 }}>
                  <XAxis
                    dataKey="bucket"
                    tick={{ fontSize: 11 }}
                    label={{
                      value: perUnitUseful ? "Price / unit (gears)" : "Price / stack (gears)",
                      position: "insideBottom",
                      offset: -4,
                      fontSize: 11,
                    }}
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    allowDecimals={false}
                    label={{
                      value: "Sold listings",
                      angle: -90,
                      position: "insideLeft",
                      fontSize: 11,
                    }}
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: 12,
                      background: "hsl(var(--popover))",
                      color: "hsl(var(--popover-foreground))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 6,
                    }}
                    labelStyle={{ color: "hsl(var(--popover-foreground))" }}
                    itemStyle={{ color: "hsl(var(--popover-foreground))" }}
                    labelFormatter={(label) =>
                      `≈ ${Number(label).toLocaleString()} gears / ${perUnitUseful ? "unit" : "stack"}`
                    }
                    formatter={(value, name) => [
                      value,
                      name === "Log-normal fit" ? "Expected (fit)" : "Sold listings",
                    ]}
                  />
                  <Bar dataKey="count" fill="#6366f1" name="Listings" radius={[2, 2, 0, 0]} />
                  <Line
                    dataKey="fit"
                    stroke="#f59e0b"
                    dot={false}
                    strokeWidth={2}
                    name="Log-normal fit"
                  />
                  <ReferenceLine x={hist.medianBucket} stroke="#10b981" strokeDasharray="4 4" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 space-y-1.5 text-xs text-muted-foreground">
              {!perUnitUseful && (
                <p>
                  This item almost always sells as full stacks, so per-unit prices round below 1
                  gear and aren&apos;t meaningful. The chart and fair price below use the{" "}
                  <span className="text-foreground">whole-stack</span> price instead.
                </p>
              )}
              <p>
                Each bar counts how many <span className="text-foreground">sold</span> listings
                traded at that price per {perUnitUseful ? "unit" : "stack"} (x-axis, in gears).
                Taller bars are the more common prices — so the tall cluster shows what most players
                actually paid.
              </p>
              <ul className="space-y-0.5">
                <li className="flex items-center gap-2">
                  <span className="inline-block h-2 w-3 shrink-0 rounded-sm bg-[#6366f1]" />
                  <span>
                    <span className="text-foreground">Listings</span> — number of real sales in each
                    price bucket.
                  </span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="inline-block h-0.5 w-3 shrink-0 bg-[#f59e0b]" />
                  <span>
                    <span className="text-foreground">Log-normal fit</span> — the typical bell-like
                    shape auction prices follow, smoothing out noise to show the overall trend.
                  </span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="inline-block h-0 w-3 shrink-0 border-t-2 border-dashed border-[#10b981]" />
                  <span>
                    <span className="text-foreground">Fair price (median)</span> — half of sales
                    were cheaper and half more expensive. Listings far left of this line are
                    bargains; far right are overpriced.
                  </span>
                </li>
              </ul>
            </div>
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

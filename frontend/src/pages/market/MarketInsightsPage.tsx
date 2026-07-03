// Market Insights — a screener surfacing every derived indicator (volatility,
// volume, demand/popularity, liquidity, deals, seller concentration, delivery
// premium, recency, confidence) per item, over a selectable time window. All
// metrics are computed client-side from the already-loaded listings (see
// `useMarketInsights`). Listing dates are shown in the in-game calendar; time to
// sell is shown in real-world time.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMarketWindow } from "./useMarketWindow";
import { ArrowDownRight, ArrowUpRight, Flame, Minus, TriangleAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { StatCard } from "@/components/usage/StatCard";
import {
  useAuctionListings,
  useAuctionSummary,
  formatGears,
  formatRealTimeToSell,
} from "@/lib/auction";
import { formatGameDate } from "./VirtualListingsTable";
import { INSIGHTS_WINDOWS, useMarketInsights } from "./useMarketInsights";
import { ScreenerTable, type ScreenerColumn } from "./InsightsScreenerTable";
import type { InsightsRow, PriceTrend } from "@/models/auction";
import { cn } from "@/lib/utils";

type VolumeMode = "price" | "unit";

const DASH = <span className="text-muted-foreground">—</span>;

/** Item volume in the currently selected mode. */
function volumeValue(r: InsightsRow, mode: VolumeMode): number {
  return mode === "price" ? r.gearsTraded : r.unitsSold;
}
function volumeDisplay(r: InsightsRow, mode: VolumeMode) {
  return mode === "price" ? formatGears(r.gearsTraded) : r.unitsSold.toLocaleString();
}

// --------------------------------------------------------------------------- //
// Badge helpers
// --------------------------------------------------------------------------- //
function VolatilityBadge({ row }: { row: InsightsRow }) {
  if (!row.volatilityTier || row.dispersionCV == null) return DASH;
  const cls =
    row.volatilityTier === "stable"
      ? "bg-emerald-600 hover:bg-emerald-600 text-white"
      : row.volatilityTier === "moderate"
        ? "bg-amber-500 hover:bg-amber-500 text-white"
        : "bg-red-600 hover:bg-red-600 text-white";
  const label =
    row.volatilityTier === "stable"
      ? "Stable"
      : row.volatilityTier === "moderate"
        ? "Moderate"
        : "Volatile";
  return (
    <Badge className={cls} title={`Dispersion CV ${(row.dispersionCV * 100).toFixed(0)}%`}>
      {label}
    </Badge>
  );
}

function TrendCell({ trend }: { trend: PriceTrend | null }) {
  if (!trend) return DASH;
  if (trend.direction === "flat") {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Minus className="size-3" /> Flat
      </span>
    );
  }
  const up = trend.direction === "up";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 tabular-nums",
        up ? "text-emerald-600" : "text-red-600",
      )}
    >
      {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
      {up ? "+" : ""}
      {trend.changePct}%
    </span>
  );
}

function DemandCell({ row }: { row: InsightsRow }) {
  if (row.demandScore == null || !row.demandTier) return DASH;
  const tier = row.demandTier;
  const cls =
    tier === "hot"
      ? "bg-red-600 hover:bg-red-600 text-white"
      : tier === "high"
        ? "bg-orange-500 hover:bg-orange-500 text-white"
        : tier === "normal"
          ? "bg-secondary text-secondary-foreground"
          : "border-border text-muted-foreground";
  const label =
    tier === "hot" ? "Hot" : tier === "high" ? "High" : tier === "normal" ? "Normal" : "Low";
  return (
    <span className="inline-flex items-center gap-1">
      <Badge
        variant={tier === "low" ? "outline" : "default"}
        className={cls}
        title={`Demand score ${row.demandScore}/100 (volume + speed + sell-through)`}
      >
        {tier === "hot" ? <Flame className="size-3" /> : null}
        {label}
      </Badge>
      {row.shortage ? (
        <TriangleAlert className="size-3.5 text-amber-500" aria-label="Shortage" />
      ) : null}
    </span>
  );
}

function ConcentrationBadge({ row }: { row: InsightsRow }) {
  if (!row.concentrationTier || row.hhi == null) return DASH;
  const tier = row.concentrationTier;
  const cls =
    tier === "competitive"
      ? "bg-emerald-600 hover:bg-emerald-600 text-white"
      : tier === "moderate"
        ? "bg-amber-500 hover:bg-amber-500 text-white"
        : "bg-red-600 hover:bg-red-600 text-white";
  const label =
    tier === "competitive"
      ? "Competitive"
      : tier === "moderate"
        ? "Moderate"
        : tier === "concentrated"
          ? "Concentrated"
          : "Monopoly";
  return (
    <Badge
      className={cls}
      title={`HHI ${(row.hhi * 100).toFixed(0)}% · ${row.sellerCount} seller(s)`}
    >
      {label}
    </Badge>
  );
}

function ConfidenceBadge({ row }: { row: InsightsRow }) {
  const label = row.confidence === "high" ? "High" : row.confidence === "medium" ? "Medium" : "Low";
  const variant =
    row.confidence === "high" ? "outline" : row.confidence === "medium" ? "secondary" : "outline";
  return (
    <Badge
      variant={variant}
      className={cn(row.confidence === "low" && "border-dashed text-muted-foreground")}
      title={`${row.soldCount} sold — statistical confidence`}
    >
      {label}
    </Badge>
  );
}

function RecencyCell({ row }: { row: InsightsRow }) {
  if (row.lastSaleGameHours == null) return DASH;
  const tier = row.recencyTier;
  const dot =
    tier === "active"
      ? "bg-emerald-500"
      : tier === "cooling"
        ? "bg-amber-500"
        : "bg-muted-foreground";
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={
        row.daysSinceLastSale != null
          ? `Last sale ~${row.daysSinceLastSale.toFixed(1)} real days ago`
          : undefined
      }
    >
      <span className={cn("size-2 rounded-full", dot)} />
      {formatGameDate(row.lastSaleGameHours)}
    </span>
  );
}

// --------------------------------------------------------------------------- //
// Column glossary
// --------------------------------------------------------------------------- //
interface GlossaryEntry {
  /** Column header this explains. */
  term: string;
  /** Plain-language meaning. */
  what: string;
  /** How to read the number/badge you see. */
  read: string;
}

const COLUMN_GLOSSARY: GlossaryEntry[] = [
  {
    term: "Volume",
    what: "Total traded in the window. Toggle shows either gears (money that changed hands) or units (quantity sold).",
    read: "Higher = more actively traded.",
  },
  {
    term: "Median/unit",
    what: "The typical per-unit sale price — the middle value, so outliers don't skew it.",
    read: "Your fair-price reference for one unit.",
  },
  {
    term: "Volatility",
    what: "How much sellers disagree on price, from the spread between the cheap (25th) and pricey (75th) sales.",
    read: "Stable = tight, predictable pricing · Volatile = wide, risky spread.",
  },
  {
    term: "Trend",
    what: "Whether the per-unit price is rising or falling — recent sales compared to older sales in the window.",
    read: "+% = getting more expensive · −% = getting cheaper · Flat = steady.",
  },
  {
    term: "Sell-through",
    what: "Of the listings that finished, the share that actually sold instead of expiring.",
    read: "High % = strong demand, sells reliably · Low % = often goes unsold.",
  },
  {
    term: "Time to sell",
    what: "Typical real-world wait from posting a listing to it selling.",
    read: "Lower = sells faster.",
  },
  {
    term: "Demand",
    what: "Popularity score (0–100) blending volume, sell speed and sell-through.",
    read: "Hot / High / Normal / Low. ⚠ marks a shortage: selling fast with little stock left.",
  },
  {
    term: "Liquidity",
    what: "How easily and quickly you can turn the item into gears (0–100).",
    read: "High = fast, reliable sales · Low = expect to wait or undercut.",
  },
  {
    term: "Deal",
    what: "How far the cheapest listings sit below the fair (median) price.",
    read: '"30%" = bargains are ~30% under median · "·N" = N live listings priced below fair right now (buy targets).',
  },
  {
    term: "Sellers",
    what: "How concentrated supply is among sellers (HHI).",
    read: "Competitive = many sellers · Concentrated / Monopoly = one or few control supply, so prices are easier to swing.",
  },
  {
    term: "Delivery +",
    what: "Extra that buyers pay for delivered listings versus pickup.",
    read: "+% = delivery commands a premium · −% = delivered listings are actually cheaper.",
  },
  {
    term: "Confidence",
    what: "How much data backs the numbers — based on the number of recorded sales.",
    read: "High = trust it · Medium = decent · Low = few sales, treat as rough.",
  },
  {
    term: "Last sale",
    what: "In-game date of the most recent sale, with a recency dot.",
    read: "Green = active · Amber = cooling off · Grey = stale.",
  },
];

function ColumnGlossary() {
  return (
    <details className="group rounded-lg border bg-muted/30">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-2.5 text-sm font-medium">
        <span>What do these columns mean?</span>
        <span className="text-xs text-muted-foreground transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="grid gap-x-6 gap-y-3 border-t px-4 py-3 sm:grid-cols-2 lg:grid-cols-3">
        {COLUMN_GLOSSARY.map((g) => (
          <div key={g.term} className="text-sm">
            <div className="font-medium">{g.term}</div>
            <p className="text-muted-foreground">{g.what}</p>
            <p className="mt-0.5 text-xs text-muted-foreground/80">{g.read}</p>
          </div>
        ))}
      </div>
    </details>
  );
}

// --------------------------------------------------------------------------- //
// Highlight cards
// --------------------------------------------------------------------------- //

// How many items each highlight card shows inline, and the max it keeps for the
// "show all" popup.
const HIGHLIGHT_PREVIEW = 5;
const HIGHLIGHT_MAX = 25;

interface Highlight {
  title: string;
  hint: string;
  rows: InsightsRow[];
  value: (r: InsightsRow) => string;
}

function HighlightCard({
  highlight,
  onSelect,
}: {
  highlight: Highlight;
  onSelect: (itemId: number) => void;
}) {
  const preview = highlight.rows.slice(0, HIGHLIGHT_PREVIEW);
  const hasMore = highlight.rows.length > HIGHLIGHT_PREVIEW;

  const renderRow = (r: InsightsRow, i: number) => (
    <li key={r.itemId}>
      <button
        type="button"
        onClick={() => onSelect(r.itemId)}
        className="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-muted/50"
      >
        <span className="min-w-0 truncate">
          <span className="mr-1 text-muted-foreground tabular-nums">{i + 1}.</span>
          {r.name}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{highlight.value(r)}</span>
      </button>
    </li>
  );

  return (
    <Card className="h-full">
      <CardContent className="py-4">
        <div className="font-medium">{highlight.title}</div>
        <p className="mb-2 text-xs text-muted-foreground">{highlight.hint}</p>
        {highlight.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not enough data.</p>
        ) : (
          <>
            <ol className="space-y-1">{preview.map(renderRow)}</ol>
            {hasMore ? (
              <Dialog>
                <DialogTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2 h-7 w-full text-xs text-muted-foreground"
                    />
                  }
                >
                  Show all {highlight.rows.length}
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>{highlight.title}</DialogTitle>
                    <DialogDescription>{highlight.hint}</DialogDescription>
                  </DialogHeader>
                  <ol className="max-h-[60vh] space-y-1 overflow-y-auto">
                    {highlight.rows.map(renderRow)}
                  </ol>
                </DialogContent>
              </Dialog>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------- //
// Page
// --------------------------------------------------------------------------- //
export function MarketInsightsPage() {
  const { data: listings, isPending, isError } = useAuctionListings();
  const { data: summary } = useAuctionSummary();
  const navigate = useNavigate();

  const [windowKey, setWindowKey] = useMarketWindow();
  const [volumeMode, setVolumeMode] = useState<VolumeMode>("price");

  const windowDays = useMemo(
    () => INSIGHTS_WINDOWS.find((w) => w.key === windowKey)?.days ?? null,
    [windowKey],
  );
  const insights = useMarketInsights(listings, windowDays);

  // Screener rows: items with at least one sale in the window carry meaningful
  // stats; drop the rest so the table isn't padded with empty indicators.
  const rows = useMemo(
    () => (insights ? insights.rows.filter((r) => r.soldCount > 0) : []),
    [insights],
  );

  const highlights = useMemo<Highlight[]>(() => {
    if (!rows.length) return [];
    const withConfidence = rows.filter((r) => r.confidence !== "low");
    const byVolatility = (dir: 1 | -1) =>
      [...withConfidence]
        .filter((r) => r.dispersionCV != null)
        .sort((a, b) => (a.dispersionCV! - b.dispersionCV!) * dir)
        .slice(0, HIGHLIGHT_MAX);
    const top = <K,>(pool: InsightsRow[], val: (r: InsightsRow) => K | null, dir: 1 | -1) =>
      [...pool]
        .filter((r) => val(r) != null)
        .sort((a, b) => ((val(a) as number) - (val(b) as number)) * dir)
        .slice(0, HIGHLIGHT_MAX);
    return [
      {
        title: "Most volatile",
        hint: "Widest price spread among sellers",
        rows: byVolatility(-1),
        value: (r) => `${((r.dispersionCV ?? 0) * 100).toFixed(0)}%`,
      },
      {
        title: "Most stable",
        hint: "Tightest, most reliable pricing",
        rows: byVolatility(1),
        value: (r) => `${((r.dispersionCV ?? 0) * 100).toFixed(0)}%`,
      },
      {
        title: "Highest volume",
        hint: volumeMode === "price" ? "Most gears traded" : "Most units sold",
        rows: top(rows, (r) => volumeValue(r, volumeMode), -1),
        value: (r) => volumeDisplay(r, volumeMode),
      },
      {
        title: "Biggest shortages",
        hint: "Sell fast with little stock left",
        rows: rows
          .filter((r) => r.shortage)
          .sort((a, b) => (b.demandScore ?? 0) - (a.demandScore ?? 0))
          .slice(0, HIGHLIGHT_MAX),
        value: (r) => `${r.activeListings} on board`,
      },
      {
        title: "Best deals",
        hint: "Cheap listings undercut the median most",
        rows: top(withConfidence, (r) => r.dealScore, -1),
        value: (r) => `${((r.dealScore ?? 0) * 100).toFixed(0)}% under`,
      },
      {
        title: "Most liquid",
        hint: "Easiest and fastest to sell",
        rows: top(rows, (r) => r.liquidityScore, -1),
        value: (r) => `${r.liquidityScore}/100`,
      },
      {
        title: "Trending up",
        hint: "Rising per-unit prices",
        rows: rows
          .filter((r) => r.trend?.direction === "up")
          .sort((a, b) => (b.trend?.changePct ?? 0) - (a.trend?.changePct ?? 0))
          .slice(0, HIGHLIGHT_MAX),
        value: (r) => `+${r.trend?.changePct ?? 0}%`,
      },
      {
        title: "Trending down",
        hint: "Falling per-unit prices",
        rows: rows
          .filter((r) => r.trend?.direction === "down")
          .sort((a, b) => (a.trend?.changePct ?? 0) - (b.trend?.changePct ?? 0))
          .slice(0, HIGHLIGHT_MAX),
        value: (r) => `${r.trend?.changePct ?? 0}%`,
      },
    ];
  }, [rows, volumeMode]);

  const columns = useMemo<ScreenerColumn<InsightsRow>[]>(
    () => [
      {
        key: "name",
        header: "Item",
        width: "minmax(11rem,1.6fr)",
        cell: (r) => <span className="font-medium">{r.name}</span>,
        sortValue: (r) => r.name.toLowerCase(),
      },
      {
        key: "volume",
        header: volumeMode === "price" ? "Volume (gears)" : "Volume (units)",
        width: "minmax(7rem,1fr)",
        align: "right",
        cell: (r) => volumeDisplay(r, volumeMode),
        sortValue: (r) => volumeValue(r, volumeMode),
        title: "Total traded in the window",
      },
      {
        key: "median",
        header: "Median/unit",
        width: "minmax(6.5rem,1fr)",
        align: "right",
        cell: (r) => (r.medianPricePerUnit != null ? formatGears(r.medianPricePerUnit) : DASH),
        sortValue: (r) => r.medianPricePerUnit,
        title: "Median per-unit sold price (fair price)",
      },
      {
        key: "volatility",
        header: "Volatility",
        width: "minmax(6rem,0.9fr)",
        align: "right",
        cell: (r) => <VolatilityBadge row={r} />,
        sortValue: (r) => r.dispersionCV,
        title: "Price dispersion: (p75 − p25) / median",
      },
      {
        key: "trend",
        header: "Trend",
        width: "minmax(5.5rem,0.8fr)",
        align: "right",
        cell: (r) => <TrendCell trend={r.trend} />,
        sortValue: (r) => r.trend?.changePct ?? null,
        title: "Recent vs older per-unit price",
      },
      {
        key: "sellThrough",
        header: "Sell-through",
        width: "minmax(6rem,0.9fr)",
        align: "right",
        cell: (r) => (r.sellThrough != null ? `${(r.sellThrough * 100).toFixed(0)}%` : DASH),
        sortValue: (r) => r.sellThrough,
        title: "Sold / (sold + expired)",
      },
      {
        key: "timeToSell",
        header: "Time to sell",
        width: "minmax(6.5rem,1fr)",
        align: "right",
        cell: (r) =>
          r.medianTimeToSellHours != null ? formatRealTimeToSell(r.medianTimeToSellHours) : DASH,
        sortValue: (r) => r.medianTimeToSellHours,
        title: "Median real-world time from posting to sale",
      },
      {
        key: "demand",
        header: "Demand",
        width: "minmax(6.5rem,0.9fr)",
        align: "right",
        cell: (r) => <DemandCell row={r} />,
        sortValue: (r) => r.demandScore,
        title: "Popularity: volume + speed + sell-through. ⚠ = shortage",
      },
      {
        key: "liquidity",
        header: "Liquidity",
        width: "minmax(5.5rem,0.8fr)",
        align: "right",
        cell: (r) => (r.liquidityScore != null ? `${r.liquidityScore}/100` : DASH),
        sortValue: (r) => r.liquidityScore,
        title: "How easily & quickly it sells",
      },
      {
        key: "deal",
        header: "Deal",
        width: "minmax(5.5rem,0.8fr)",
        align: "right",
        cell: (r) =>
          r.dealScore != null ? (
            <span>
              {(r.dealScore * 100).toFixed(0)}%
              {r.dealsAvailable > 0 ? (
                <span className="ml-1 text-emerald-600" title="Active listings below fair price">
                  ·{r.dealsAvailable}
                </span>
              ) : null}
            </span>
          ) : (
            DASH
          ),
        sortValue: (r) => r.dealScore,
        title: "How far cheap listings undercut the median (+ live deals)",
      },
      {
        key: "concentration",
        header: "Sellers",
        width: "minmax(6.5rem,0.9fr)",
        align: "right",
        cell: (r) => <ConcentrationBadge row={r} />,
        sortValue: (r) => r.hhi,
        title: "Seller concentration (HHI)",
      },
      {
        key: "delivery",
        header: "Delivery +",
        width: "minmax(5.5rem,0.8fr)",
        align: "right",
        cell: (r) =>
          r.deliveryPremiumPct != null
            ? `${r.deliveryPremiumPct > 0 ? "+" : ""}${r.deliveryPremiumPct}%`
            : DASH,
        sortValue: (r) => r.deliveryPremiumPct,
        title: "Delivered vs non-delivered price premium",
      },
      {
        key: "confidence",
        header: "Confidence",
        width: "minmax(6rem,0.8fr)",
        align: "right",
        cell: (r) => <ConfidenceBadge row={r} />,
        sortValue: (r) => r.soldCount,
        title: "Sample size behind the stats",
      },
      {
        key: "lastSale",
        header: "Last sale",
        width: "minmax(7rem,1fr)",
        align: "right",
        cell: (r) => <RecencyCell row={r} />,
        sortValue: (r) => (r.daysSinceLastSale != null ? -r.daysSinceLastSale : null),
        title: "In-game date of the most recent sale",
      },
    ],
    [volumeMode],
  );

  if (isPending) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
        <Spinner /> Loading market data…
      </div>
    );
  }
  if (isError || !listings || !insights) {
    return <p className="py-12 text-center text-destructive">Failed to load market data.</p>;
  }

  const t = insights.totals;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Market Insights</h1>
        <p className="text-xs text-muted-foreground">
          Derived indicators per item. Listing dates use the in-game calendar; time to sell is
          real-world. Windows are real days of play (1 real day ≈ 1 in-game month).
          {summary ? (
            <> Snapshot updated {new Date(summary.generatedUtc).toLocaleString()}.</>
          ) : null}
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1">
          {INSIGHTS_WINDOWS.map((w) => (
            <Button
              key={w.key}
              size="sm"
              variant={windowKey === w.key ? "default" : "outline"}
              onClick={() => setWindowKey(w.key)}
            >
              {w.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-sm text-muted-foreground">Volume:</span>
          <Button
            size="sm"
            variant={volumeMode === "price" ? "default" : "outline"}
            onClick={() => setVolumeMode("price")}
          >
            Gears
          </Button>
          <Button
            size="sm"
            variant={volumeMode === "unit" ? "default" : "outline"}
            onClick={() => setVolumeMode("unit")}
          >
            Units
          </Button>
        </div>
      </div>

      {/* Window totals */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Gears traded" value={formatGears(t.gearsTraded)} />
        <StatCard label="Units sold" value={t.unitsSold} />
        <StatCard label="Sales" value={t.soldCount} />
        <StatCard
          label="Sell-through"
          value={t.sellThrough != null ? `${(t.sellThrough * 100).toFixed(0)}%` : "—"}
        />
        <StatCard label="Items traded" value={t.uniqueItemsTraded} />
        <StatCard
          label="Median time to sell"
          value={
            t.medianTimeToSellHours != null ? formatRealTimeToSell(t.medianTimeToSellHours) : "—"
          }
        />
      </div>

      {/* Highlights */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {highlights.map((h) => (
          <HighlightCard
            key={h.title}
            highlight={h}
            onSelect={(itemId) => navigate(`/market/items/${itemId}`)}
          />
        ))}
      </div>

      {/* Screener */}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Item screener</h2>
          <span className="text-xs text-muted-foreground">
            {rows.length.toLocaleString()} items · click a row for details · click a header to sort
          </span>
        </div>
        <div className="mb-3">
          <ColumnGlossary />
        </div>
        {rows.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground">
            No sales recorded in this window.
          </p>
        ) : (
          // Break out of the centered page container so the wide screener can
          // use the full viewport width (minus a little breathing room).
          <div className="mx-[calc(50%-50vw)] px-4 sm:px-6 lg:px-8">
            <ScreenerTable
              rows={rows}
              columns={columns}
              rowKey={(r) => r.itemId}
              defaultSortKey="volume"
              defaultSortDir="desc"
              minWidth="1180px"
              onRowClick={(r) => navigate(`/market/items/${r.itemId}`)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

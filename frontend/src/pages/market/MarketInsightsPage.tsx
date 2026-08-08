// Market Insights — a screener surfacing every derived indicator (volatility,
// volume, demand/popularity, liquidity, deals, seller concentration, delivery
// premium, recency, confidence) per item, over a selectable time window. All
// metrics are computed client-side from the already-loaded listings (see
// `useMarketInsights`). Listing dates are shown in the in-game calendar; time to
// sell is shown in real-world time.

import { useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useMarketWindow } from "./useMarketWindow";
import {
  ArrowDownRight,
  ArrowUpRight,
  Columns3,
  Download,
  ExternalLink,
  Flame,
  Minus,
  Star,
  TriangleAlert,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatCard } from "@/components/usage/StatCard";
import {
  useAuctionListings,
  useAuctionSummary,
  formatGears,
  formatRealTimeToSell,
} from "@/lib/auction";
import { formatGameDate } from "./VirtualListingsTable";
import { INSIGHTS_WINDOWS, resolveWindowDays, useMarketInsights } from "./useMarketInsights";
import { ScreenerTable, type ScreenerColumn } from "./InsightsScreenerTable";
import { InsightsFilterBar } from "./InsightsFilterBar";
import { useFilteredInsights, rowPrice } from "./useFilteredInsights";
import { useMarketPriceMode } from "./useMarketPriceMode";
import { useMarketVolumeMode } from "./useMarketVolumeMode";
import { Sparkline } from "./Sparkline";
import { downloadInsightsCsv } from "./insightsCsv";
import {
  HIDEABLE_INSIGHTS_COLUMNS,
  showAllInsightsColumns,
  toggleInsightsColumn,
  useInsightsHiddenColumns,
} from "./useInsightsColumns";
import { PriceModeInfo } from "./PriceModeInfo";
import { patchInsightsFilters } from "@/store/slices/insightsFilters";
import { toggleFavorite } from "@/store/slices/marketFavorites";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import type { InsightsRow } from "@/models/auction";
import { cn } from "@/lib/utils";

type VolumeMode = "price" | "unit";

const DASH = <span className="text-muted-foreground">—</span>;

/** Star toggle for the Item column. Subscribes to just this item's favorite
 *  state so toggling one row doesn't re-render the whole screener. */
function FavoriteStar({ itemId }: { itemId: number }) {
  const dispatch = useAppDispatch();
  const isFavorite = useAppSelector((s) => s.marketFavorites.ids.includes(itemId));
  return (
    <button
      type="button"
      aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={isFavorite}
      onClick={(e) => {
        e.stopPropagation();
        dispatch(toggleFavorite(itemId));
      }}
      className="-ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded hover:bg-muted"
    >
      <Star
        className={cn(
          "size-3.5 transition-colors",
          isFavorite
            ? "fill-amber-400 text-amber-400"
            : "text-muted-foreground/40 hover:text-muted-foreground",
        )}
      />
    </button>
  );
}

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

/** Wraps a cell in the app's Tooltip so we never fall back to the native
 *  browser `title` tooltip. */
function Hint({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex items-center gap-1.5" />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

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
    <Hint label={`Dispersion CV ${(row.dispersionCV * 100).toFixed(0)}%`}>
      <Badge className={cls}>{label}</Badge>
    </Hint>
  );
}

function TrendCell({ row }: { row: InsightsRow }) {
  const { trend, priceSeries } = row;
  const spark =
    priceSeries && priceSeries.length >= 2 ? (
      <Sparkline
        data={priceSeries}
        className={cn(
          "shrink-0",
          trend?.direction === "up"
            ? "text-emerald-600"
            : trend?.direction === "down"
              ? "text-red-600"
              : "text-muted-foreground/70",
        )}
      />
    ) : null;

  let label: ReactNode;
  if (!trend) {
    label = spark ? null : DASH;
  } else if (trend.direction === "flat") {
    label = (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Minus className="size-3" /> Flat
      </span>
    );
  } else {
    const up = trend.direction === "up";
    label = (
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

  if (!spark && !trend) return DASH;
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      {spark}
      {label}
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
      <Hint label={`Demand score ${row.demandScore}/100 (volume + speed + sell-through)`}>
        <Badge
          variant={tier === "low" ? "outline" : "default"}
          className={cn("w-18 justify-center", cls)}
        >
          {tier === "hot" ? <Flame className="size-3" /> : null}
          {label}
        </Badge>
      </Hint>
      <span className="inline-flex w-3.5 justify-center">
        {row.shortage ? (
          <Hint label="Shortage — strong demand with little stock left">
            <TriangleAlert className="size-3.5 text-amber-500" aria-label="Shortage" />
          </Hint>
        ) : null}
      </span>
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
    <Hint label={`HHI ${(row.hhi * 100).toFixed(0)}% · ${row.sellerCount} seller(s)`}>
      <Badge className={cls}>{label}</Badge>
    </Hint>
  );
}

function ConfidenceBadge({ row }: { row: InsightsRow }) {
  const label = row.confidence === "high" ? "High" : row.confidence === "medium" ? "Medium" : "Low";
  const variant =
    row.confidence === "high" ? "outline" : row.confidence === "medium" ? "secondary" : "outline";
  return (
    <Hint label={`${row.soldCount} sold — statistical confidence`}>
      <Badge
        variant={variant}
        className={cn(row.confidence === "low" && "border-dashed text-muted-foreground")}
      >
        {label}
      </Badge>
    </Hint>
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
  const dotLabel = tier === "active" ? "Active" : tier === "cooling" ? "Cooling off" : "Stale";
  const content = (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-2 rounded-full", dot)} role="img" aria-label={dotLabel} />
      {formatGameDate(row.lastSaleGameHours)}
    </span>
  );
  return row.daysSinceLastSale != null ? (
    <Hint label={`Last sale ~${row.daysSinceLastSale.toFixed(1)} real days ago`}>{content}</Hint>
  ) : (
    content
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
  /** Optional “learn more” link (e.g. Wikipedia for the underlying metric). */
  link?: { label: string; href: string };
}

const COLUMN_GLOSSARY: GlossaryEntry[] = [
  {
    term: "Volume",
    what: "Total traded in the window. Toggle shows either gears (money that changed hands) or units (quantity sold).",
    read: "Higher = more actively traded.",
  },
  {
    term: "Median/unit",
    what: "The typical per-unit sale price. The price toggle switches this between the plain median (middle sale, outlier-resistant) and a quantity-weighted median, where each sale counts in proportion to the quantity it moved so bulk trades set the price.",
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
    link: {
      label: "About HHI",
      href: "https://en.wikipedia.org/wiki/Herfindahl%E2%80%93Hirschman_index",
    },
  },
  {
    term: "Delivery +",
    what: "Extra that buyers pay for delivered listings (sent to them) versus pickup (they travel to collect).",
    read: "+% = delivery commands a premium · −% = delivered listings are actually cheaper. Example: if pickup sells for ~10 gears and delivered for ~8, that's −20% (delivered went for less).",
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
            {g.link ? (
              <a
                href={g.link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-0.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                {g.link.label}
                <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : null}
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
// Column visibility picker
// --------------------------------------------------------------------------- //
function ColumnPicker({ hidden }: { hidden: string[] }) {
  const shown = HIDEABLE_INSIGHTS_COLUMNS.length - hidden.length;
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="gap-1.5" />}>
        <Columns3 className="size-4" />
        Columns
        {hidden.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            {shown}/{HIDEABLE_INSIGHTS_COLUMNS.length}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-52 p-1">
        <div className="max-h-[min(20rem,60vh)] overflow-y-auto">
          {HIDEABLE_INSIGHTS_COLUMNS.map((c) => (
            <label
              key={c.key}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60"
            >
              <Checkbox
                checked={!hidden.includes(c.key)}
                onCheckedChange={() => toggleInsightsColumn(c.key)}
              />
              {c.label}
            </label>
          ))}
        </div>
        {hidden.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 h-7 w-full text-xs text-muted-foreground"
            onClick={() => showAllInsightsColumns()}
          >
            Show all
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// --------------------------------------------------------------------------- //
// Loading skeleton — mirrors the page layout (header, controls, totals,
// highlights, screener) so the transition into loaded content is stable.
// --------------------------------------------------------------------------- //
function MarketInsightsSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true">
      {/* Header */}
      <div className="space-y-2">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-3 w-full max-w-2xl" />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-56" />
      </div>

      {/* Window totals */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>

      {/* Highlights */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-44 w-full" />
        ))}
      </div>

      {/* Screener */}
      <div className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-112 w-full" />
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Page
// --------------------------------------------------------------------------- //
export function MarketInsightsPage() {
  const { data: listings, isPending, isError } = useAuctionListings();
  const { data: summary } = useAuctionSummary();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const filters = useAppSelector((s) => s.insightsFilters);
  const favoriteIds = useAppSelector((s) => s.marketFavorites.ids);
  const favorites = useMemo(() => new Set(favoriteIds), [favoriteIds]);

  const [windowKey, setWindowKey] = useMarketWindow();
  const [volumeMode, setVolumeMode] = useMarketVolumeMode();
  const [priceMode, setPriceMode] = useMarketPriceMode();
  const hiddenColumns = useInsightsHiddenColumns();

  const windowDays = useMemo(
    () => resolveWindowDays(windowKey, summary?.recordingStartGameHours),
    [windowKey, summary?.recordingStartGameHours],
  );
  const insights = useMarketInsights(listings, windowDays);

  // Screener rows: items with at least one sale in the window carry meaningful
  // stats; drop the rest so the table isn't padded with empty indicators.
  const rows = useMemo(
    () => (insights ? insights.rows.filter((r) => r.soldCount > 0) : []),
    [insights],
  );

  // Categories present in the (window-scoped) screener rows, for the filter bar.
  const categories = useMemo(() => Array.from(new Set(rows.map((r) => r.category))).sort(), [rows]);

  // Filters apply to the screener table only — highlight cards and window totals
  // below intentionally use the full `rows`/`insights` so they stay market-wide.
  const filteredRows = useFilteredInsights(rows, filters, volumeMode, priceMode, favorites);

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
        cell: (r) => (
          <span className="flex items-center gap-1.5 font-medium">
            <FavoriteStar itemId={r.itemId} />
            <span className="truncate">{r.name}</span>
          </span>
        ),
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
        header: priceMode === "weighted" ? "Weighted/unit" : "Median/unit",
        width: "minmax(6.5rem,1fr)",
        align: "right",
        cell: (r) => {
          const p = rowPrice(r, priceMode);
          if (p == null) return DASH;
          if (!r.upperBoundUnknown) return formatGears(p);
          return (
            <Hint label="Upper price bound unknown — nothing ever sold or expired above this, so treat it as a floor, not a ceiling.">
              <span className="inline-flex items-center gap-0.5">
                <span className="text-muted-foreground">≥</span>
                {formatGears(p)}
              </span>
            </Hint>
          );
        },
        sortValue: (r) => rowPrice(r, priceMode),
        title:
          priceMode === "weighted"
            ? "Quantity-weighted median per-unit sold price (bulk trades dominate)"
            : "Median per-unit sold price (fair price)",
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
        width: "minmax(8rem,1.1fr)",
        align: "right",
        cell: (r) => <TrendCell row={r} />,
        sortValue: (r) => r.trend?.changePct ?? null,
        title: "Recent vs older per-unit price, with an in-window price sparkline",
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
                <Hint label="Active listings below fair price">
                  <span className="ml-1 text-emerald-600">·{r.dealsAvailable}</span>
                </Hint>
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
    [volumeMode, priceMode],
  );

  // The "Item" column is always shown; the rest respect the persisted picker.
  const visibleColumns = useMemo(
    () => columns.filter((c) => c.key === "name" || !hiddenColumns.includes(c.key)),
    [columns, hiddenColumns],
  );

  if (isPending) {
    return <MarketInsightsSkeleton />;
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
        <div className="flex items-center gap-1" role="group" aria-label="Time window">
          {INSIGHTS_WINDOWS.map((w) => (
            <Button
              key={w.key}
              size="sm"
              variant={windowKey === w.key ? "default" : "outline"}
              aria-pressed={windowKey === w.key}
              onClick={() => setWindowKey(w.key)}
            >
              {w.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Volume unit">
          <span className="mr-1 text-sm text-muted-foreground">Volume:</span>
          <Button
            size="sm"
            variant={volumeMode === "price" ? "default" : "outline"}
            aria-pressed={volumeMode === "price"}
            onClick={() => setVolumeMode("price")}
          >
            Gears
          </Button>
          <Button
            size="sm"
            variant={volumeMode === "unit" ? "default" : "outline"}
            aria-pressed={volumeMode === "unit"}
            onClick={() => setVolumeMode("unit")}
          >
            Units
          </Button>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Price basis">
          <span className="mr-1 text-sm text-muted-foreground">Price:</span>
          <Button
            size="sm"
            variant={priceMode === "median" ? "default" : "outline"}
            aria-pressed={priceMode === "median"}
            onClick={() => setPriceMode("median")}
          >
            Median
          </Button>
          <Button
            size="sm"
            variant={priceMode === "weighted" ? "default" : "outline"}
            aria-pressed={priceMode === "weighted"}
            onClick={() => setPriceMode("weighted")}
          >
            Qty-weighted
          </Button>
          <PriceModeInfo />
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
        <StatCard label="Delivery fees paid" value={formatGears(t.deliveryFeesPaid)} />
        <StatCard
          label="Delivered sales"
          value={
            t.deliveryRate != null
              ? `${t.deliveredCount.toLocaleString()} · ${(t.deliveryRate * 100).toFixed(0)}%`
              : "—"
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
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-lg font-semibold">Item screener</h2>
            <span className="text-xs text-muted-foreground">
              {filteredRows.length.toLocaleString()}
              {filteredRows.length !== rows.length
                ? ` of ${rows.length.toLocaleString()}`
                : ""}{" "}
              items · click a row for details · click a header to sort
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ColumnPicker hidden={hiddenColumns} />
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={filteredRows.length === 0}
              onClick={() =>
                downloadInsightsCsv(
                  filteredRows,
                  volumeMode,
                  priceMode,
                  (INSIGHTS_WINDOWS.find((w) => w.key === windowKey)?.label ?? windowKey)
                    .replace(/\s+/g, "-")
                    .toLowerCase(),
                )
              }
            >
              <Download className="size-4" />
              Export CSV
            </Button>
          </div>
        </div>
        <div className="mb-3">
          <ColumnGlossary />
        </div>
        <div className="mb-3">
          <InsightsFilterBar categories={categories} />
        </div>
        {rows.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground">
            No sales recorded in this window.
          </p>
        ) : filteredRows.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground">
            No items match the current filters.
          </p>
        ) : (
          // Break out of the centered page container so the wide screener can
          // use the full viewport width (minus a little breathing room).
          <div className="mx-[calc(50%-50vw)] px-4 sm:px-6 lg:px-8">
            <ScreenerTable
              rows={filteredRows}
              columns={visibleColumns}
              rowKey={(r) => r.itemId}
              sortKey={filters.sortKey}
              sortDir={filters.sortDir}
              onSortChange={(key, dir) =>
                dispatch(patchInsightsFilters({ sortKey: key, sortDir: dir }))
              }
              minWidth="1180px"
              onRowClick={(r) => navigate(`/market/items/${r.itemId}`)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

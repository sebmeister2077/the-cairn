import { useMemo, useState } from "react";
import { useParams, Link, useNavigate, useLocation } from "react-router-dom";
import { ExternalLink, Info, ArrowLeft, ArrowUp } from "lucide-react";
import {
  ComposedChart,
  Bar,
  Line,
  BarChart,
  XAxis,
  YAxis,
  Tooltip as ChartTooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatCard } from "@/components/usage/StatCard";
import {
  useAuctionListings,
  formatGears,
  formatRealTimeToSell,
  percentileSorted,
  variantBase,
  useItemCatalog,
  splitOreHostRock,
  humanizeItemCode,
  listingHasText,
  listingToolAttributes,
  computeRelatedItems,
} from "@/lib/auction";
import type { PriceTrend } from "@/models/auction";
import { getTapestryImage } from "./tapestryImages";
import {
  VirtualListingsTable,
  formatListingDate,
  formatGameDate,
  DeliveryFeeCell,
  ListingNotesCell,
  ListingAttributesCell,
  type ListingColumn,
} from "./VirtualListingsTable";
import {
  INSIGHTS_WINDOWS,
  computeMarketInsights,
  filterListingsByWindow,
  saleGameHours,
} from "./useMarketInsights";
import { useMarketWindow } from "./useMarketWindow";
import { useMarketPriceMode } from "./useMarketPriceMode";
import { PriceModeInfo } from "./PriceModeInfo";

/** Build a price histogram plus a fitted log-normal density curve. `markerValue`
 * is the price the dashed "fair price" reference line should snap to (the plain
 * median by default; the quantity-weighted price when that mode is active). */
function buildHistogram(prices: number[], bins = 24, markerValue?: number) {
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
  // Snap the fair-price marker to the bucket that actually contains it so the
  // reference line lands on a real category on the axis. Defaults to the median,
  // but follows the active price mode when a weighted marker is supplied.
  const marker = markerValue != null && Number.isFinite(markerValue) ? markerValue : median;
  const medianIdx = Math.min(bins - 1, Math.max(0, Math.floor((marker - min) / width)));
  const medianBucket = bars[medianIdx]?.bucket ?? round(marker);
  return { bars, median, p25, p75, medianBucket };
}

/** Small colored pill showing whether the recent price is trending up/down. */
function TrendBadge({
  trend,
  perUnit,
  stackSize,
}: {
  trend: PriceTrend;
  perUnit: boolean;
  stackSize: number;
}) {
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
  // The trend medians are per-unit (server-side). When the page is stack-priced
  // the per-unit figures round below 1 gear and read poorly (e.g. 0.703/unit),
  // so scale them to whole-stack prices to match the rest of the page. The
  // percentage change is a ratio, so it's unaffected by the scaling.
  const unit = perUnit ? "unit" : "stack";
  const scale = perUnit ? 1 : stackSize || 1;
  const fmt = (m: number) => (m * scale).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm font-medium ${cls}`}
    >
      <span aria-hidden>{arrow}</span>
      {label}
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label="How is the price trend calculated?"
              className="inline-flex cursor-pointer items-center rounded-full p-0.5 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Info className="size-4" />
            </button>
          }
        />
        <PopoverContent className="max-w-xs">
          <div className="space-y-1.5 text-left">
            <p>
              Compares this item&apos;s recent sale prices against older ones to show whether
              it&apos;s getting more expensive (▲), cheaper (▼), or holding steady (→).
            </p>
            <p>
              Timeframe: the most recent third of recorded sales (by real-world time) vs. the rest —
              here the latest {trend.recentCount} sales (median {fmt(trend.recentMedian)}/{unit})
              against the {trend.olderCount} older sales (median {fmt(trend.olderMedian)}/{unit}).
            </p>
            <p>Changes within ±8% are treated as “Stable price”.</p>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}

/** Amber caveat chip shown when the market never revealed a price ceiling for
 * an item: no expired listing was ever priced above the highest one that sold.
 * In that case the "fair price" is really a floor — buyers might have paid more
 * — so we flag that the true upper bound is unknown. */
function UpperBoundUnknownBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/15 px-2.5 py-1 text-sm font-medium text-amber-600">
      <ArrowUp className="size-4" aria-hidden />
      Upper price bound unknown
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label="Why is the upper price bound unknown?"
              className="inline-flex cursor-pointer items-center rounded-full p-0.5 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Info className="size-4" />
            </button>
          }
        />
        <PopoverContent className="max-w-xs">
          <div className="space-y-1.5 text-left">
            <p>
              No expired listing for this item was ever priced above the highest one that actually
              sold.
            </p>
            <p>
              That means the market never showed a price too high to sell at, so the true ceiling is
              unknown — the fair price here is likely a{" "}
              <span className="text-foreground">floor</span>, and buyers may have been willing to
              pay more.
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}

/** Selectable histogram resolutions. More bins = smaller price step, which
 * resolves tight clusters when an item has big price swings. */
const BIN_OPTIONS = [
  { label: "Coarse", bins: 12 },
  { label: "Standard", bins: 24 },
  { label: "Fine", bins: 48 },
  { label: "Ultra-fine", bins: 96 },
] as const;

export function MarketItemPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const id = Number(itemId);
  const listingsQ = useAuctionListings();
  const catalogQ = useItemCatalog();
  const navigate = useNavigate();
  const location = useLocation();

  // Shared market time-range window (kept in sync with the Insights page).
  const [windowKey, setWindowKey] = useMarketWindow();
  const windowDays = useMemo(
    () => INSIGHTS_WINDOWS.find((w) => w.key === windowKey)?.days ?? null,
    [windowKey],
  );

  // Shared price mode (median vs quantity-weighted), synced across market pages.
  const [priceMode, setPriceMode] = useMarketPriceMode();

  // Histogram bin count. Higher = finer price buckets (smaller per-unit step).
  const [bins, setBins] = useState(24);
  // Show only sold listings in the Recent listings table.
  const [soldOnly, setSoldOnly] = useState(false);
  // Volume-over-time series unit: total gears vs total units.
  const [volumeMode, setVolumeMode] = useState<"price" | "unit">("price");

  // Ores are a single ore type embedded in different host rocks — a distinct
  // block id per rock (e.g. "Ore bountiful hematite granite" vs "…peridotite")
  // but functionally the same tradeable item. On this item page we merge all of
  // an ore's host-rock variants into one view so the sell prices aggregate. The
  // grouping is derived from the item catalog's codes (listings carry no code),
  // and only kicks in when the ore actually has more than one host-rock form.
  const oreGroup = useMemo(() => {
    const catalog = catalogQ.data;
    if (!catalog) return null;
    const entry = catalog[String(id)];
    if (!entry || entry.category !== "ore" || !entry.code) return null;
    const { base } = splitOreHostRock(entry.code);
    const ids = new Set<number>();
    const rockByItemId = new Map<number, string | null>();
    for (const [key, e] of Object.entries(catalog)) {
      if (e.category !== "ore" || !e.code) continue;
      const split = splitOreHostRock(e.code);
      if (split.base !== base) continue;
      const iid = Number(key);
      ids.add(iid);
      rockByItemId.set(iid, split.rock);
    }
    if (ids.size <= 1) return null;
    // Some ores (e.g. anthracite, sulfur) exist both as a standalone item —
    // the thing people actually trade — and as an ore still embedded in a host
    // rock (e.g. "ore-anthracite-chalk"), a distinct block only listed when the
    // ore hasn't been extracted. When the group mixes both forms we let the
    // price figures drop the host-rock blocks by default (see `includeHostRock`).
    const rocks = Array.from(rockByItemId.values());
    const hostRockSplit = rocks.some((r) => r == null) && rocks.some((r) => r != null);
    return { base, name: humanizeItemCode(base), ids, rockByItemId, hostRockSplit };
  }, [catalogQ.data, id]);
  const combineOres = oreGroup != null;
  // When an ore has both a standalone item and host-rock block forms, the price
  // stats default to the standalone item only (host rocks excluded). The user
  // can opt to fold the host-rock listings back into the price figures. The
  // Recent listings table always shows every form regardless of this toggle.
  const [includeHostRock, setIncludeHostRock] = useState(false);

  // "Related items": other forms of the same underlying material — e.g. from an
  // iron ore, link to the other iron ores, iron nugget, iron bloom and iron
  // ingot; from a sulfur chunk, link to powdered sulfur. Derived from the item
  // catalog's material families (plus any hand-crafted MANUAL_LINKS), restricted
  // to raw/intermediate material forms (so finished tools that merely share a
  // metal name don't show up) and to items that actually have market data (so
  // links land on a populated page). Ore host-rock variants collapse into one
  // entry, mirroring this page's merge.
  const related = useMemo(() => {
    const catalog = catalogQ.data;
    if (!catalog) return null;
    // itemIds already represented by this page (a merged ore host-rock group, or
    // just the current item) must not appear as "related".
    const selfIds = oreGroup ? oreGroup.ids : new Set<number>([id]);
    // Only surface items we have listings for, so the link opens a page with data.
    const active = new Set((listingsQ.data ?? []).map((l) => l.itemId));
    return computeRelatedItems(id, catalog, selfIds, active);
  }, [catalogQ.data, listingsQ.data, id, oreGroup]);

  const itemListings = useMemo(() => {
    const all = listingsQ.data ?? [];
    if (combineOres && oreGroup) return all.filter((l) => oreGroup.ids.has(l.itemId));
    return all.filter((l) => l.itemId === id);
  }, [listingsQ.data, id, combineOres, oreGroup]);

  // Listings that feed the price/market figures (fair price, distribution,
  // sell-through, trend…). For ores that exist both as a standalone item and as
  // ore embedded in a host rock, drop the host-rock blocks unless the user opts
  // to include them — people trade the extracted item, so the host-rock blocks
  // would otherwise skew the price. The Recent listings table stays untouched.
  const priceListings = useMemo(() => {
    if (combineOres && oreGroup && oreGroup.hostRockSplit && !includeHostRock) {
      return itemListings.filter((l) => !oreGroup.rockByItemId.get(l.itemId));
    }
    return itemListings;
  }, [itemListings, combineOres, oreGroup, includeHostRock]);

  // Listings restricted to the selected window (by in-game posting time).
  const windowListings = useMemo(
    () => filterListingsByWindow(itemListings, windowDays),
    [itemListings, windowDays],
  );

  // Window-restricted view of the price listings (host-rock blocks optionally
  // excluded). Drives every price figure below; `windowListings` (all forms)
  // still drives the volume series and the Recent listings table.
  const priceWindowListings = useMemo(
    () => filterListingsByWindow(priceListings, windowDays),
    [priceListings, windowDays],
  );

  // Reuse the Insights engine for this single item so every windowed stat
  // (trend, fair price, sell-through, time to sell…) matches the screener page
  // exactly. All of this item's listings share one itemId, so there's a single
  // row. Composite demand/liquidity scores aren't meaningful for one item and
  // aren't shown here.
  const insight = useMemo(() => {
    if (!priceListings.length) return null;
    // When merging an ore's host-rock variants, remap every listing onto this
    // page's itemId (and a shared display name) so the Insights engine treats
    // them as one item and returns a single combined row.
    const src =
      combineOres && oreGroup
        ? priceListings.map((l) => ({ ...l, itemId: id, name: oreGroup.name }))
        : priceListings;
    return computeMarketInsights(src, windowDays).rows[0] ?? null;
  }, [priceListings, windowDays, combineOres, oreGroup, id]);

  const trend = insight?.trend ?? null;

  // Listings whose price should count toward the fair-price figures. Written
  // parchments/books (a story or advert someone penned) are priced for their
  // content, not as the raw item, so they're dropped from the price histogram,
  // per-unit and per-stack medians — but stay in the volume series and the
  // recent-listings table below.
  const pricedWindowListings = useMemo(
    () => priceWindowListings.filter((l) => !listingHasText(l)),
    [priceWindowListings],
  );

  const soldPpu = useMemo(
    () => pricedWindowListings.filter((l) => l.sold).map((l) => l.pricePerUnit),
    [pricedWindowListings],
  );

  // The market never revealed a price ceiling when no expired listing was ever
  // priced above the highest one that actually sold. With no evidence that any
  // price was ever "too high", the fair price is really a floor, not a true
  // upper bound.
  const upperBoundUnknown = useMemo(() => {
    if (soldPpu.length === 0) return false;
    const maxSold = Math.max(...soldPpu);
    const expiredPpu = pricedWindowListings
      .filter((l) => l.state === "Expired")
      .map((l) => l.pricePerUnit);
    return expiredPpu.every((p) => p <= maxSold);
  }, [soldPpu, pricedWindowListings]);

  // Representative full-stack size for the item. We prefer the item's real
  // in-game maximum stack size (from the game registry, carried on the item
  // catalog) so the "per stack" figure matches what a full stack actually is.
  // Listings can be posted in partial stacks (e.g. 16 of a 64-stack item), so we
  // normalize every listing to this size (per-unit × stackSize) to get a
  // comparable per-stack price and to scale the trend into whole-stack terms.
  // When the registry has no stack size for this id (e.g. synthetic clutter/
  // tapestry groups), we fall back to the largest stack we've actually seen sold.
  const stackSize = useMemo(() => {
    const known = catalogQ.data?.[String(id)]?.maxStackSize;
    if (known && known > 0) return known;
    let max = 1;
    for (const l of pricedWindowListings) {
      if (l.sold && l.qty > max) max = l.qty;
    }
    return max;
  }, [catalogQ.data, id, pricedWindowListings]);

  // Some items are only ever sold as full stacks, so the per-unit median can
  // round down to below 1 gear (e.g. 28 gears for a stack of 32). In that case
  // we treat the item as "stack-priced": the "Fair price" card and the chart
  // below both switch to whole-stack prices so the numbers stay meaningful and
  // the histogram shows a real spread instead of everything collapsing onto
  // 0 / 1 per-unit buckets. Each listing is normalized to the full stack size
  // (per-unit price × stack size), so partial-stack listings (e.g. a half-stack
  // sold for less) don't drag the per-stack figure below its true value.
  const soldStackPrices = useMemo(
    () => pricedWindowListings.filter((l) => l.sold).map((l) => l.pricePerUnit * stackSize),
    [pricedWindowListings, stackSize],
  );

  // `priceStats.median` is the per-unit median (windowed). When it drops below 2
  // gears per unit the per-unit view rounds poorly, so we fall back to whole-
  // stack prices — but only when we actually know the item's stack size (a stack
  // of more than one), since otherwise there's nothing to convert to.
  const perUnitUseful = (insight?.priceStats?.median ?? 0) >= 2 || stackSize <= 1;
  const chartPrices = perUnitUseful ? soldPpu : soldStackPrices;

  // Quantity-weighted fair price (per-unit) from the Insights engine; the
  // per-stack figure scales linearly with the stack size (weighted median of
  // pricePerUnit × stackSize = stackSize × weighted median of pricePerUnit).
  const weightedUnit = insight?.weightedPricePerUnit ?? null;
  const weightedStack = weightedUnit != null ? weightedUnit * stackSize : null;

  // Value the dashed reference line snaps to. In weighted mode it follows the
  // quantity-weighted price; in median mode we leave it undefined so the
  // histogram keeps snapping to its own median (unchanged behaviour).
  const markerValue =
    priceMode === "weighted" ? (perUnitUseful ? weightedUnit : weightedStack) : null;
  const hist = useMemo(
    () => buildHistogram(chartPrices, bins, markerValue ?? undefined),
    [chartPrices, bins, markerValue],
  );

  const medianStackPrice = useMemo(() => {
    const prices = [...soldStackPrices].sort((a, b) => a - b);
    // Use the same interpolated median as the histogram (`buildHistogram`) so
    // the "Fair price / stack" card and the green median line on the chart
    // always agree. A naive `prices[floor(n/2)]` picks the upper-middle sample
    // for even-sized sets, which disagreed with the chart's true median.
    return percentileSorted(prices, 0.5);
  }, [soldStackPrices]);

  // The fair-price figures shown in the card, honoring the active price mode.
  const fairUnit = priceMode === "weighted" ? weightedUnit : (insight?.priceStats?.median ?? null);
  const fairStack = priceMode === "weighted" ? weightedStack : medianStackPrice;
  const priceModeWeighted = priceMode === "weighted";

  // Volume of sold listings over time, bucketed by in-game sale time across the
  // selected window. Shows either total gears traded or total units sold.
  const volumeSeries = useMemo(() => {
    const sold = windowListings
      .filter((l) => l.sold && saleGameHours(l) != null)
      .map((l) => ({ t: saleGameHours(l)!, price: l.price, qty: l.qty }));
    if (sold.length === 0) return [];
    let minT = Infinity;
    let maxT = -Infinity;
    for (const s of sold) {
      if (s.t < minT) minT = s.t;
      if (s.t > maxT) maxT = s.t;
    }
    const BUCKETS = 16;
    const span = maxT - minT || 1;
    const width = span / BUCKETS;
    const bars = Array.from({ length: BUCKETS }, (_, i) => ({
      t: minT + (i + 0.5) * width,
      label: formatGameDate(minT + (i + 0.5) * width),
      gears: 0,
      units: 0,
    }));
    for (const s of sold) {
      let idx = Math.floor((s.t - minT) / width);
      if (idx < 0) idx = 0;
      if (idx >= BUCKETS) idx = BUCKETS - 1;
      bars[idx].gears += s.price;
      bars[idx].units += s.qty;
    }
    return bars;
  }, [windowListings]);

  // Newest first by in-game posting time (matches the Game date column),
  // restricted to the window and optionally to sold listings only.
  const sortedListings = useMemo(() => {
    const base = soldOnly ? windowListings.filter((l) => l.sold) : windowListings;
    return [...base].sort((a, b) => (b.postedTotalHours ?? 0) - (a.postedTotalHours ?? 0));
  }, [windowListings, soldOnly]);

  // Grouped clutter items (e.g. "Toy") bundle many distinct objects; when this
  // item is one of them, surface each listing's exact variant ("toy7") so the
  // specific object is visible even though they aggregate under one item.
  const hasVariants = useMemo(() => itemListings.some((l) => l.variant), [itemListings]);

  // Whether any of this item's listings carry written text (e.g. a parchment
  // someone wrote a story or advert on). Those are excluded from the fair-price
  // figures above but still listed here, tagged in a "Notes" column.
  const hasTextListings = useMemo(() => itemListings.some(listingHasText), [itemListings]);

  // Whether any listing is a tool/weapon carrying notable attributes (a worn
  // condition, remaining durability, or a buff). Only then do we add the
  // "Details" column that opens a per-listing attribute popover.
  const hasToolAttrs = useMemo(
    () => itemListings.some((l) => listingToolAttributes(l).length > 0),
    [itemListings],
  );

  // Distinct in-game clutter codes (attrs.type) covered by this grouped item, so
  // the item page can spell out exactly which objects it represents.
  const variantCodes = useMemo(
    () =>
      Array.from(new Set(itemListings.map((l) => l.variant).filter((v): v is string => !!v))).sort(
        (a, b) => a.localeCompare(b, undefined, { numeric: true }),
      ),
    [itemListings],
  );

  // Tapestries aren't in the survival handbook/wiki, so we ship prepared artwork
  // and show it on the item page. All pieces of one tapestry share a type base.
  const tapestryImage = useMemo(() => {
    if (itemListings[0]?.category !== "tapestry" || variantCodes.length === 0) return null;
    return getTapestryImage(variantBase(variantCodes[0]));
  }, [itemListings, variantCodes]);

  const columns = useMemo<ListingColumn[]>(
    () => [
      ...(hasVariants
        ? [
            {
              key: "variant",
              header: "Variant",
              width: "minmax(6rem,1fr)",
              cell: (l) => (
                <span className="text-xs font-medium" title="In-game clutter object">
                  {l.variant ?? "—"}
                </span>
              ),
            } satisfies ListingColumn,
          ]
        : []),
      ...(combineOres && oreGroup
        ? [
            {
              key: "hostRock",
              header: "Host rock",
              width: "minmax(6rem,1fr)",
              cell: (l) => (
                <span
                  className="text-xs font-medium capitalize"
                  title="Rock stratum this ore was found in"
                >
                  {oreGroup.rockByItemId.get(l.itemId) ?? "—"}
                </span>
              ),
            } satisfies ListingColumn,
          ]
        : []),
      ...(hasTextListings
        ? [
            {
              key: "notes",
              header: "Notes",
              width: "minmax(4.5rem,0.8fr)",
              cell: (l) => <ListingNotesCell listing={l} />,
            } satisfies ListingColumn,
          ]
        : []),
      ...(hasToolAttrs
        ? [
            {
              key: "attrs",
              header: "Details",
              width: "minmax(5rem,0.8fr)",
              cell: (l) => <ListingAttributesCell listing={l} />,
            } satisfies ListingColumn,
          ]
        : []),
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
        key: "timeToSell",
        header: "Sold in",
        width: "minmax(5.5rem,0.9fr)",
        align: "right",
        cell: (l) => (
          <span
            className="text-xs text-muted-foreground"
            title="Real-world time from posting to sale"
          >
            {l.sold && l.timeToSellHours != null ? formatRealTimeToSell(l.timeToSellHours) : "—"}
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
        key: "status",
        header: "Status",
        width: "5rem",
        cell: (l) => {
          // Coalesce for data generated before verdictObserved existed.
          const verdictObserved = l.verdictObserved ?? l.state !== "Active";
          const unconfirmed = !l.sold && !verdictObserved;
          return (
            <span
              className="text-xs text-muted-foreground"
              title={
                unconfirmed
                  ? "Final outcome never recorded — last observed state, not a confirmed live listing"
                  : undefined
              }
            >
              {l.sold ? "sold" : unconfirmed ? "active?" : l.state.toLowerCase()}
            </span>
          );
        },
      },
    ],
    [hasVariants, combineOres, oreGroup, hasTextListings, hasToolAttrs],
  );

  if (listingsQ.isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
        <Spinner /> Loading…
      </div>
    );
  }
  if (itemListings.length === 0) {
    return (
      <div className="py-12 text-center space-y-2">
        <p className="text-muted-foreground">No data for this item.</p>
        <Link to="/market/listings" className="text-primary hover:underline">
          Back to listings
        </Link>
      </div>
    );
  }

  const onBack = () => {
    // Go back to wherever the user came from; fall back to the listings page on
    // a fresh load (no in-app history entry to pop).
    if (location.key !== "default") navigate(-1);
    else navigate("/market/listings");
  };

  const ps = insight?.priceStats ?? null;
  // `insight` is null when the item has no non-spam activity in the window. It
  // still has raw listings to show, so fall back to the first listing for the
  // name/category header. Merged ores use the host-rock-agnostic group name.
  const displayName =
    (combineOres && oreGroup ? oreGroup.name : insight?.name) ?? itemListings[0]?.name ?? `#${id}`;
  const displayCategory = insight?.category ?? itemListings[0]?.category ?? "unknown";

  return (
    <div className="space-y-5">
      <div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{displayName}</h1>
          {trend && <TrendBadge trend={trend} perUnit={perUnitUseful} stackSize={stackSize} />}
          {upperBoundUnknown && <UpperBoundUnknownBadge />}
          <a
            href={`https://wiki.vintagestory.at/index.php?search=${encodeURIComponent(displayName)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-input px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
            title="Look up this item on the Vintage Story Wiki"
          >
            <ExternalLink className="h-3 w-3" aria-hidden />
            Wiki
          </a>
        </div>
        <p className="text-sm text-muted-foreground">
          {displayCategory} · #{id}
        </p>
        {combineOres && oreGroup && (
          <p className="mt-1 text-xs text-muted-foreground">
            Combined across{" "}
            {
              new Set(Array.from(oreGroup.rockByItemId.values()).filter((r): r is string => !!r))
                .size
            }{" "}
            host rocks — sell prices are aggregated for every stratum this ore is found in.
          </p>
        )}
        {combineOres && oreGroup?.hostRockSplit && (
          <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={includeHostRock}
              onCheckedChange={(v) => setIncludeHostRock(v === true)}
            />
            Include host-rock blocks in price
            <Popover>
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    aria-label="What are host-rock blocks?"
                    className="inline-flex cursor-pointer items-center rounded-full p-0.5 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <Info className="size-4" />
                  </button>
                }
              />
              <PopoverContent className="max-w-xs">
                <p className="text-left">
                  This ore also exists as a block still embedded in a host rock, which is only
                  listed when the ore hasn't been extracted. Those blocks are excluded from the
                  price figures by default so they don't skew the value of the item itself. The
                  Recent listings table below always shows every form.
                </p>
              </PopoverContent>
            </Popover>
          </label>
        )}
        {variantCodes.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              {variantCodes.length > 1 ? "Game codes:" : "Game code:"}
            </span>
            {variantCodes.map((c) => (
              <Badge key={c} variant="secondary" className="font-mono text-xs font-normal">
                {c}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {related && (
        <Card>
          <CardContent className="py-4">
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="font-semibold">Related items</h2>
              <span className="text-xs text-muted-foreground">{related.label}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {related.items.map((r) => (
                <Link
                  key={r.id}
                  to={`/market/items/${r.id}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-input px-3 py-1 text-sm hover:bg-accent/50 hover:text-foreground transition-colors"
                  title={`View ${r.name}`}
                >
                  <span className="font-medium">{r.name}</span>
                  <span className="text-xs text-muted-foreground capitalize">{r.category}</span>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {tapestryImage && (
        <figure className="w-fit rounded-md border bg-muted/30 p-3">
          <img
            src={tapestryImage}
            alt={`${displayName} tapestry`}
            className="max-h-80 w-auto max-w-full rounded object-contain"
            loading="lazy"
          />
          <figcaption className="mt-2 text-xs text-muted-foreground">
            In-game tapestry artwork (assembled from all pieces)
          </figcaption>
        </figure>
      )}

      {/* Time-range window (shared with the Insights page) */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm text-muted-foreground">Time range:</span>
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
        <span className="ml-1 text-xs text-muted-foreground">1 real day ≈ 1 in-game month</span>
      </div>

      {/* Price basis (shared with the Insights & Converter pages) */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm text-muted-foreground">Price:</span>
        <Button
          size="sm"
          variant={priceMode === "median" ? "default" : "outline"}
          onClick={() => setPriceMode("median")}
        >
          Median
        </Button>
        <Button
          size="sm"
          variant={priceMode === "weighted" ? "default" : "outline"}
          onClick={() => setPriceMode("weighted")}
        >
          Qty-weighted
        </Button>
        <PriceModeInfo />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label={perUnitUseful ? "Fair price / unit" : "Fair price / stack"}
          value={
            perUnitUseful
              ? fairUnit != null
                ? formatGears(fairUnit)
                : "—"
              : fairStack != null
                ? formatGears(fairStack)
                : "—"
          }
          hint={
            priceModeWeighted
              ? perUnitUseful
                ? "Quantity-weighted median of sold listings (bulk trades dominate)"
                : `Quantity-weighted median sold price, normalized to a full stack of ${stackSize}`
              : perUnitUseful
                ? "Median of sold listings"
                : `Median sold price, normalized to a full stack of ${stackSize}`
          }
        />
        <StatCard
          label="Units sold"
          value={insight?.unitsSold ?? 0}
          hint={
            stackSize > 1
              ? `${((insight?.unitsSold ?? 0) / stackSize).toLocaleString(undefined, {
                  maximumFractionDigits: 1,
                })} stacks`
              : undefined
          }
        />
        <StatCard
          label="Sell-through"
          value={insight?.sellThrough != null ? `${(insight.sellThrough * 100).toFixed(0)}%` : "—"}
          hint={insight ? `${insight.listings.toLocaleString()} listings` : undefined}
        />
        <StatCard
          label="Median time to sell"
          value={
            insight?.medianTimeToSellHours != null
              ? formatRealTimeToSell(insight.medianTimeToSellHours)
              : "—"
          }
          hint="Real-world time"
        />
      </div>

      {ps && (
        <Card>
          <CardContent className="py-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <h2 className="font-semibold">
                {perUnitUseful
                  ? "Price-per-unit distribution (sold)"
                  : "Price-per-stack distribution (sold)"}
              </h2>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  p25 {hist.p25.toLocaleString()} · median {hist.median.toLocaleString()} · p75{" "}
                  {hist.p75.toLocaleString()}
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Detail</span>
                  <Select value={String(bins)} onValueChange={(v) => setBins(Number(v))}>
                    <SelectTrigger className="h-7 w-30 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BIN_OPTIONS.map((o) => (
                        <SelectItem key={o.bins} value={String(o.bins)}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
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
                  <ChartTooltip
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
                    <span className="text-foreground">
                      Fair price ({priceModeWeighted ? "qty-weighted" : "median"})
                    </span>{" "}
                    —{" "}
                    {priceModeWeighted
                      ? "the quantity-weighted typical price, where bulk trades count for more."
                      : "half of sales were cheaper and half more expensive."}{" "}
                    Listings far left of this line are bargains; far right are overpriced.
                  </span>
                </li>
              </ul>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Volume over time */}
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div>
              <h2 className="font-semibold">Volume over time</h2>
              <p className="text-xs text-muted-foreground">
                {volumeMode === "price" ? "Gears traded" : "Units sold"} per period, over the
                selected range (by in-game sale date).
              </p>
            </div>
            <div className="flex items-center gap-1">
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
          {volumeSeries.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No sales in this range.
            </p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={volumeSeries} margin={{ top: 4, right: 8, bottom: 18, left: 4 }}>
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10 }}
                    interval="preserveStartEnd"
                    minTickGap={16}
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    allowDecimals={false}
                    width={48}
                    tickFormatter={(v: number) =>
                      v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)
                    }
                  />
                  <ChartTooltip
                    contentStyle={{
                      fontSize: 12,
                      background: "hsl(var(--popover))",
                      color: "hsl(var(--popover-foreground))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 6,
                    }}
                    labelStyle={{ color: "hsl(var(--popover-foreground))" }}
                    itemStyle={{ color: "hsl(var(--popover-foreground))" }}
                    labelFormatter={(label) => `≈ ${label}`}
                    formatter={(value) => [
                      Number(value).toLocaleString(),
                      volumeMode === "price" ? "Gears traded" : "Units sold",
                    ]}
                  />
                  <Bar
                    dataKey={volumeMode === "price" ? "gears" : "units"}
                    fill="#6366f1"
                    name={volumeMode === "price" ? "Gears traded" : "Units sold"}
                    radius={[2, 2, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Recent listings ({sortedListings.length})</h2>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <Checkbox checked={soldOnly} onCheckedChange={(v) => setSoldOnly(v === true)} />
            Sold only
          </label>
        </div>
        <VirtualListingsTable listings={sortedListings} columns={columns} />
      </div>
    </div>
  );
}

// Item Converter — a barter/exchange calculator for the Auction House.
//
// Every item on the Auction House is priced in Rusty Gears (⚙), so the exchange
// rate between any two items is simply the ratio of their per-unit gear prices.
// Add the items you *have* (each with a quantity) plus a target you *want*, and
// this page shows the equivalent quantity — as a low–typical–high band — along
// with the gear value of each side, e.g. how much resin ≈ one gold ingot.
//
// The medians come from `computeMarketInsights` (the same windowed aggregation
// the Insights page uses), so the "Time range" and "Price basis" controls both
// change the rate. The conversion math is isolated in `computeExchange` so a
// future multi-item "basket" mode can sum gear values across several rows.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeftRight, Plus, TrendingDown, TrendingUp, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { QtyStepper } from "@/components/QtyStepper";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  useAuctionListings,
  useAuctionSummary,
  formatGears,
  formatRealTimeToSell,
} from "@/lib/auction";
import { cn } from "@/lib/utils";
import { useAppSelector } from "@/store/hooks";
import { ExternalTradeToggle } from "@/components/market/ExternalTradeToggle";
import {
  INSIGHTS_WINDOWS,
  computeMarketInsights,
  confidenceFor,
  resolveWindowDays,
  type InsightsWindowKey,
} from "@/hooks/useMarketInsights";
import { useMarketWindow } from "@/hooks/useMarketWindow";
import { useMarketPriceMode, setMarketPriceMode } from "@/hooks/useMarketPriceMode";
import type { ConfidenceTier, InsightsRow, PriceTrend } from "@/models/auction";

// --------------------------------------------------------------------------- //
// Conversion math (pure — basket-mode ready)
// --------------------------------------------------------------------------- //

/** Which figure from a row's per-unit price distribution drives the rate. */
export type PriceBasis = "weighted" | "median" | "mean" | "p25" | "p75";

const BASIS_OPTIONS: { value: PriceBasis; label: string; hint: string }[] = [
  {
    value: "weighted",
    label: "Quantity-weighted",
    hint: "Median where bulk trades set the price",
  },
  { value: "median", label: "Median (typical)", hint: "Middle of sold prices" },
  { value: "mean", label: "Average", hint: "Mean of sold prices" },
  { value: "p25", label: "Cheap (p25)", hint: "Lower quartile — buying cheap" },
  { value: "p75", label: "Premium (p75)", hint: "Upper quartile — selling high" },
];

// --------------------------------------------------------------------------- //
// Persisted selection
// --------------------------------------------------------------------------- //
// The chosen items, quantity and price basis are kept in a tiny persisted store
// so the converter isn't wiped when you follow a "Details" link to an item page
// and navigate back (the page unmounts in between). Mirrors `useMarketWindow`.

interface HaveLine {
  name: string;
  qty: string;
}

interface ConverterState {
  have: HaveLine[];
  wantName: string;
  basis: PriceBasis;
}

const CONVERTER_STORAGE_KEY = "market.converter";
const VALID_BASIS = new Set<PriceBasis>(["weighted", "median", "mean", "p25", "p75"]);
const VALID_WINDOW = new Set<string>(INSIGHTS_WINDOWS.map((w) => w.key));
const DEFAULT_STATE: ConverterState = {
  have: [{ name: "", qty: "1" }],
  wantName: "",
  basis: "median",
};

/** Accept a "have" basket from either the URL form ([name, qty] tuples) or the
 * stored object form ({ name, qty }), dropping anything malformed. */
function coerceHave(raw: unknown): HaveLine[] | null {
  if (!Array.isArray(raw)) return null;
  const lines: HaveLine[] = [];
  for (const entry of raw) {
    if (Array.isArray(entry) && typeof entry[0] === "string") {
      lines.push({ name: entry[0], qty: typeof entry[1] === "string" ? entry[1] : "1" });
    } else if (entry && typeof entry === "object") {
      const o = entry as Record<string, unknown>;
      if (typeof o.name === "string") {
        lines.push({ name: o.name, qty: typeof o.qty === "string" ? o.qty : "1" });
      }
    }
  }
  return lines.length ? lines : null;
}

function loadConverterState(): ConverterState {
  try {
    const raw = localStorage.getItem(CONVERTER_STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Migrate the earlier single-item schema ({ haveName, qty }).
    const have =
      coerceHave(parsed.have) ??
      (typeof parsed.haveName === "string" && parsed.haveName
        ? [{ name: parsed.haveName, qty: typeof parsed.qty === "string" ? parsed.qty : "1" }]
        : DEFAULT_STATE.have);
    return {
      have,
      wantName: typeof parsed.wantName === "string" ? parsed.wantName : "",
      basis:
        typeof parsed.basis === "string" && VALID_BASIS.has(parsed.basis as PriceBasis)
          ? (parsed.basis as PriceBasis)
          : "median",
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function persistConverter(state: ConverterState): void {
  try {
    localStorage.setItem(
      CONVERTER_STORAGE_KEY,
      JSON.stringify({
        have: state.have.map((l) => [l.name, l.qty]),
        wantName: state.wantName,
        basis: state.basis,
      }),
    );
  } catch {
    /* ignore persistence failures */
  }
}

// --- Shareable URL state ---------------------------------------------------- //
// The selection (basket, target, basis, time range) is mirrored into the query
// string so a converter can be linked, bookmarked and shared. To keep links
// short and readable, items are referenced by their numeric item id rather than
// their (URL-unfriendly) display names, e.g. `?have=42x5,108x2&want=108`.

/** Build the query string for a selection. Item names are resolved to their
 * item id via `rowByName`; lines that don't resolve to a priced item yet are
 * omitted from the shareable link (they remain in localStorage for the return
 * trip). */
function stateToSearchParams(
  state: ConverterState,
  windowKey: string,
  rowByName: Map<string, InsightsRow>,
): URLSearchParams {
  const p = new URLSearchParams();
  const haveParts: string[] = [];
  for (const l of state.have) {
    const name = l.name.trim();
    if (!name) continue;
    const row = rowByName.get(name.toLowerCase());
    if (!row) continue;
    haveParts.push(`${row.itemId}x${l.qty}`);
  }
  if (haveParts.length) p.set("have", haveParts.join(","));
  const wantRow = rowByName.get(state.wantName.trim().toLowerCase());
  if (wantRow) p.set("want", String(wantRow.itemId));
  if (state.basis !== "median") p.set("basis", state.basis);
  if (windowKey) p.set("window", windowKey);
  return p;
}

/** Parse the `have` query value in the id form `<id>x<qty>,<id>x<qty>`. */
function parseHaveIds(param: string | null): { id: number; qty: string }[] | null {
  if (!param) return null;
  const out: { id: number; qty: string }[] = [];
  for (const chunk of param.split(",")) {
    const [idStr, qtyStr] = chunk.split("x");
    const id = Number.parseInt(idStr, 10);
    if (!Number.isFinite(id)) continue;
    out.push({ id, qty: qtyStr && /^\d+$/.test(qtyStr) ? qtyStr : "1" });
  }
  return out.length ? out : null;
}

/** Item-id selection carried in a shared link, resolved to names once market
 * data has loaded. `null` fields mean "not present in the URL". */
interface IdSelection {
  haveIds: { id: number; qty: string }[] | null;
  wantId: number | null;
}

/** Extract the id-based selection from the URL for deferred hydration. Legacy
 * name-based links (`have=[...]`) are handled synchronously in
 * `resolveInitialState` instead and are ignored here. */
function parseIdSelection(params: URLSearchParams): IdSelection {
  const haveParam = params.get("have");
  const haveIds = haveParam && !haveParam.startsWith("[") ? parseHaveIds(haveParam) : null;
  const wantParam = params.get("want");
  const wantId = wantParam && /^\d+$/.test(wantParam) ? Number.parseInt(wantParam, 10) : null;
  return { haveIds, wantId };
}

interface BootstrapState extends ConverterState {
  windowKey: string | null;
}

/** Resolve the initial selection: URL query first (shareable links), then the
 * persisted store, then defaults. Item names/quantities carried as item ids are
 * resolved separately once market data loads (see `parseIdSelection`); only the
 * legacy name form, basis and window can be applied synchronously here. */
function resolveInitialState(params: URLSearchParams): BootstrapState {
  const stored = loadConverterState();
  let { have, wantName, basis } = stored;
  let windowKey: string | null = null;

  // Legacy name-based `have=[["Resin","5"]]` links (no market data needed).
  const haveParam = params.get("have");
  if (haveParam && haveParam.startsWith("[")) {
    try {
      const coerced = coerceHave(JSON.parse(haveParam));
      if (coerced) have = coerced;
    } catch {
      /* ignore malformed query */
    }
  }
  // Legacy name-based `want=Gold ingot` links (id form is hydrated later).
  const wantParam = params.get("want");
  if (wantParam && !/^\d+$/.test(wantParam)) wantName = wantParam;

  const basisParam = params.get("basis");
  if (basisParam && VALID_BASIS.has(basisParam as PriceBasis)) basis = basisParam as PriceBasis;
  const windowParam = params.get("window");
  if (windowParam && VALID_WINDOW.has(windowParam)) windowKey = windowParam;

  return { have, wantName, basis, windowKey };
}

/** Per-unit gear price for a row under the chosen basis, or `null` when the
 * item has no usable sold-price data in the current window. */
export function gearsPerUnit(row: InsightsRow | undefined, basis: PriceBasis): number | null {
  if (basis === "weighted") {
    const w = row?.weightedPricePerUnit;
    return w != null && Number.isFinite(w) && w > 0 ? w : null;
  }
  const ps = row?.priceStats;
  if (!ps) return null;
  const v = ps[basis];
  return Number.isFinite(v) && v > 0 ? v : null;
}

export interface ExchangeResult {
  /** Per-unit gear price of the item being spent. */
  fromGpu: number;
  /** Per-unit gear price of the item being acquired. */
  toGpu: number;
  /** Total gear value of the spent side (fromGpu × fromQty). */
  fromGears: number;
  /** Equivalent quantity of the wanted item (fromGears ÷ toGpu). */
  wantUnits: number;
}

/**
 * Convert `fromQty` units of `fromRow` into an equivalent quantity of `toRow`
 * at the given price basis. Returns `null` if either side lacks price data or
 * the quantity is non-positive. Kept as a single-pair pure function so a basket
 * mode can call it per line item and sum `fromGears`.
 */
export function computeExchange(
  fromRow: InsightsRow | undefined,
  toRow: InsightsRow | undefined,
  fromQty: number,
  basis: PriceBasis,
): ExchangeResult | null {
  const fromGpu = gearsPerUnit(fromRow, basis);
  const toGpu = gearsPerUnit(toRow, basis);
  if (fromGpu == null || toGpu == null || !(fromQty > 0)) return null;
  const fromGears = fromGpu * fromQty;
  return { fromGpu, toGpu, fromGears, wantUnits: fromGears / toGpu };
}

export interface BasketLine {
  name: string;
  row: InsightsRow;
  qty: number;
  gears: number;
}

export interface BasketResult {
  lines: BasketLine[];
  totalGears: number;
  /** A typed-in item couldn't be priced (unknown, no data, or bad quantity). */
  incomplete: boolean;
}

/** Total gear value of every priced line in a "have" basket. Skips unpriceable
 * rows and flags that via `incomplete`. Basket mode is just `computeExchange`
 * summed across lines. */
export function computeBasket(
  have: HaveLine[],
  rowByName: Map<string, InsightsRow>,
  basis: PriceBasis,
): BasketResult {
  const lines: BasketLine[] = [];
  let totalGears = 0;
  let incomplete = false;
  for (const l of have) {
    const name = l.name.trim();
    if (!name) continue;
    const row = rowByName.get(name.toLowerCase());
    const gpu = gearsPerUnit(row, basis);
    const qty = Number.parseFloat(l.qty);
    if (!row || gpu == null || !(qty > 0)) {
      incomplete = true;
      continue;
    }
    const gears = gpu * qty;
    lines.push({ name: row.name, row, qty, gears });
    totalGears += gears;
  }
  return { lines, totalGears, incomplete };
}

export interface UnitsRange {
  low: number;
  typ: number;
  high: number;
}

/** How many units of `wantRow` a gear budget buys, as a low–typical–high band
 * derived from the want item's own price spread (p75 → fewer, p25 → more). This
 * is the honest "range, not a point estimate" for the result. */
export function wantUnitsRange(
  totalGears: number,
  wantRow: InsightsRow | undefined,
  basis: PriceBasis,
): UnitsRange | null {
  const typGpu = gearsPerUnit(wantRow, basis);
  if (typGpu == null || !(totalGears > 0) || !wantRow?.priceStats) return null;
  const ps = wantRow.priceStats;
  const cheap = ps.p25 > 0 ? ps.p25 : typGpu;
  const dear = ps.p75 > 0 ? ps.p75 : typGpu;
  return {
    typ: totalGears / typGpu,
    high: totalGears / cheap,
    low: totalGears / dear,
  };
}

// --------------------------------------------------------------------------- //
// Display helpers
// --------------------------------------------------------------------------- //

/** Format an item quantity with just enough precision to stay readable. */
function formatQty(n: number): string {
  if (n >= 100) return Math.round(n).toLocaleString();
  if (n >= 10) return n.toFixed(1);
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(2);
}

/** Whether the low–high band is wide enough to be worth showing (>5% either
 * side of the typical estimate). */
function showBand(r: UnitsRange): boolean {
  if (!(r.typ > 0) || !(r.low > 0)) return false;
  return r.high / r.typ > 1.05 || r.typ / r.low > 1.05;
}

const CONFIDENCE_META: Record<
  ConfidenceTier,
  { label: string; variant: "secondary" | "outline" | "destructive" }
> = {
  high: { label: "High confidence", variant: "secondary" },
  medium: { label: "Fair confidence", variant: "outline" },
  low: { label: "Low confidence", variant: "destructive" },
};

function ConfidenceBadge({ soldCount }: { soldCount: number }) {
  const tier = confidenceFor(soldCount);
  const meta = CONFIDENCE_META[tier];
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant={meta.variant} className="cursor-default" />}>
        {meta.label}
      </TooltipTrigger>
      <TooltipContent>
        Based on {soldCount.toLocaleString()} sold listing{soldCount === 1 ? "" : "s"} in this time
        range.
      </TooltipContent>
    </Tooltip>
  );
}

// --------------------------------------------------------------------------- //
// Item stat line (price, trend, confidence, liquidity, details)
// --------------------------------------------------------------------------- //

function TrendIndicator({ trend }: { trend: PriceTrend | null }) {
  if (!trend || trend.direction === "flat") return null;
  const up = trend.direction === "up";
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex cursor-default items-center gap-0.5 text-xs font-medium",
              up ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
            )}
          />
        }
      >
        <Icon className="h-3 w-3" aria-hidden />
        {up ? "+" : ""}
        {trend.changePct}%
      </TooltipTrigger>
      <TooltipContent>
        Recent sold prices are {up ? "up" : "down"} {Math.abs(trend.changePct)}% versus earlier in
        this time range.
      </TooltipContent>
    </Tooltip>
  );
}

function LiquidityHint({ row }: { row: InsightsRow }) {
  const parts = [`${row.activeListings.toLocaleString()} listed now`];
  if (row.medianTimeToSellHours != null) {
    parts.push(`~${formatRealTimeToSell(row.medianTimeToSellHours)} to sell`);
  }
  return <span className="text-xs text-muted-foreground">{parts.join(" · ")}</span>;
}

/** Per-unit price, price trend, confidence, liquidity and a details link for a
 * resolved item. Used for the target item and a single-item basket. */
function ItemStatsLine({ row, basis }: { row: InsightsRow; basis: PriceBasis }) {
  const gpu = gearsPerUnit(row, basis);
  if (gpu == null) {
    return (
      <p className="text-sm text-destructive">
        No sold-price data for this item in the selected time range. Try a wider range.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="text-muted-foreground tabular-nums">{formatGears(gpu)} / unit</span>
      <TrendIndicator trend={row.trend} />
      <ConfidenceBadge soldCount={row.soldCount} />
      <span className="text-muted-foreground">·</span>
      <LiquidityHint row={row} />
      <Link to={`/market/items/${row.itemId}`} className="text-xs text-primary hover:underline">
        Details
      </Link>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Page
// --------------------------------------------------------------------------- //

export function MarketConverterPage() {
  const { data: listings, isPending, isError } = useAuctionListings();
  const { data: summary } = useAuctionSummary();

  const [searchParams, setSearchParams] = useSearchParams();
  const [windowKey, setWindowKey] = useMarketWindow();

  // Bootstrap once: URL query (shareable links) → persisted store → defaults.
  const boot = useRef<BootstrapState | null>(null);
  if (boot.current == null) boot.current = resolveInitialState(searchParams);

  // Item-id selection from a shared link, captured once (the URL-sync effect
  // rewrites the query below, so we must read it before that runs).
  const idSelection = useRef<IdSelection | null>(null);
  if (idSelection.current == null) idSelection.current = parseIdSelection(searchParams);

  const [basis, setBasis] = useState<PriceBasis>(boot.current.basis);
  const [wantName, setWantName] = useState(boot.current.wantName);
  const [have, setHave] = useState<HaveLine[]>(boot.current.have);

  // The "typical" basis (Quantity-weighted ↔ Median) is mirrored to the shared
  // price-mode store so the choice carries to the Insights and item pages. The
  // p25/mean/p75 refinements are converter-only and leave the global mode alone.
  const [priceMode] = useMarketPriceMode();
  const setBasisSynced = (next: PriceBasis) => {
    setBasis(next);
    if (next === "weighted") setMarketPriceMode("weighted");
    else if (next === "median") setMarketPriceMode("median");
  };
  // React to the global mode changing on another page: swap the typical basis to
  // match, leaving explicit p25/mean/p75 picks untouched.
  useEffect(() => {
    if (priceMode === "weighted" && basis !== "weighted") setBasis("weighted");
    else if (priceMode === "median" && basis === "weighted") setBasis("median");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceMode]);

  // Whether it's safe to mirror state back into the URL. When a shared link
  // carries item ids we must wait until they've been resolved to names before
  // writing, otherwise the id-sync effect would clobber the link on mount.
  const pendingHydration = Boolean(
    idSelection.current.haveIds || idSelection.current.wantId != null,
  );
  const [urlSyncReady, setUrlSyncReady] = useState(!pendingHydration);

  // Apply a time range carried in a shared link, once.
  const bootWindow = boot.current.windowKey;
  useEffect(() => {
    if (bootWindow) setWindowKey(bootWindow as InsightsWindowKey);
    // A shared link (or stored converter) using the weighted basis should also
    // set the shared price mode so the rest of the market pages agree.
    if (boot.current?.basis === "weighted") setMarketPriceMode("weighted");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Basket editing helpers.
  const setLineName = (i: number, v: string) =>
    setHave((prev) => prev.map((l, idx) => (idx === i ? { ...l, name: v } : l)));
  const setLineQty = (i: number, v: string) =>
    setHave((prev) => prev.map((l, idx) => (idx === i ? { ...l, qty: v } : l)));
  const addLine = () => setHave((prev) => [...prev, { name: "", qty: "1" }]);
  const removeLine = (i: number) =>
    setHave((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      return next.length ? next : [{ name: "", qty: "1" }];
    });

  const windowDays = useMemo(
    () => resolveWindowDays(windowKey, summary?.recordingStartGameHours),
    [windowKey, summary?.recordingStartGameHours],
  );

  // Shared "hide off-platform trades" toggle (synced across market pages).
  const excludeExternalTrades = useAppSelector((s) => s.auctionFilters.excludeExternalTrades);

  const insights = useMemo(
    () =>
      listings && listings.length
        ? computeMarketInsights(listings, windowDays, excludeExternalTrades)
        : null,
    [listings, windowDays, excludeExternalTrades],
  );

  // Resolve item names to their best insights row. Item names can repeat across
  // ids, so keep the row with the most sales (the most reliable price signal).
  const { rowByName, rowById, suggestions } = useMemo(() => {
    const byName = new Map<string, InsightsRow>();
    const byId = new Map<number, InsightsRow>();
    if (insights) {
      for (const row of insights.rows) {
        if (row.soldCount <= 0 || row.priceStats == null) continue;
        byId.set(row.itemId, row);
        const key = row.name.toLowerCase();
        const existing = byName.get(key);
        if (!existing || row.soldCount > existing.soldCount) byName.set(key, row);
      }
    }
    const names = Array.from(byName.values())
      .map((r) => r.name)
      .sort((a, b) => a.localeCompare(b));
    return { rowByName: byName, rowById: byId, suggestions: names };
  }, [insights]);

  // Hydrate a shared item-id link once market data is available: resolve the
  // ids to names, apply them, then allow URL syncing to resume.
  useEffect(() => {
    if (urlSyncReady) return; // nothing pending, or already hydrated
    if (rowById.size === 0) return; // wait for market data
    const sel = idSelection.current!;
    if (sel.haveIds) {
      const lines = sel.haveIds
        .map(({ id, qty }) => {
          const row = rowById.get(id);
          return row ? { name: row.name, qty } : null;
        })
        .filter((l): l is HaveLine => l != null);
      if (lines.length) setHave(lines);
    }
    if (sel.wantId != null) {
      const row = rowById.get(sel.wantId);
      if (row) setWantName(row.name);
    }
    setUrlSyncReady(true);
  }, [rowById, urlSyncReady]);

  // Mirror the selection into the URL (shareable, id-based) and localStorage
  // (return trip). Held back until any shared id-link has been hydrated.
  useEffect(() => {
    if (!urlSyncReady) return;
    const params = stateToSearchParams({ have, wantName, basis }, windowKey, rowByName);
    setSearchParams(params, { replace: true });
    persistConverter({ have, wantName, basis });
  }, [have, wantName, basis, windowKey, rowByName, urlSyncReady, setSearchParams]);

  // Popular items (by gears traded) offered as quick-pick targets.
  const popular = useMemo(() => {
    if (!insights) return [];
    return [...insights.rows]
      .filter((r) => r.soldCount > 0 && r.priceStats)
      .sort((a, b) => b.gearsTraded - a.gearsTraded)
      .slice(0, 8)
      .map((r) => r.name);
  }, [insights]);

  const wantRow = rowByName.get(wantName.trim().toLowerCase());
  const basket = useMemo(() => computeBasket(have, rowByName, basis), [have, rowByName, basis]);
  const range = useMemo(
    () => wantUnitsRange(basket.totalGears, wantRow, basis),
    [basket.totalGears, wantRow, basis],
  );

  const canSwap = have.length === 1;
  const swap = () => {
    if (!canSwap) return;
    const single = have[0];
    setHave([{ name: wantName, qty: single.qty }]);
    setWantName(single.name);
  };

  if (isPending) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
        <Spinner /> Loading market data…
      </div>
    );
  }
  if (isError || !listings) {
    return <p className="text-destructive py-12 text-center">Failed to load market data.</p>;
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Item Converter</h1>
        <p className="text-sm text-muted-foreground">
          Estimate how much your items barter for using Auction House prices in Rusty Gears (⚙). Add
          everything you have, pick a target, and get a low–typical–high estimate.
        </p>
      </div>

      {/* Controls: time range + price basis */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
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
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Price basis:</span>
          <Select value={basis} onValueChange={(v) => setBasisSynced(v as PriceBasis)}>
            <SelectTrigger size="sm" className="w-44">
              <SelectValue>
                {(value) => BASIS_OPTIONS.find((o) => o.value === value)?.label ?? value}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {BASIS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ExternalTradeToggle className="text-muted-foreground" />
      </div>

      {/* Quick picks: popular target items */}
      {popular.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Popular targets:</span>
          {popular.map((name) => (
            <Button
              key={name}
              size="sm"
              variant={wantName === name ? "default" : "outline"}
              onClick={() => setWantName(name)}
            >
              {name}
            </Button>
          ))}
        </div>
      )}

      {/* Item pickers: a "have" basket → a single "want" target */}
      <div className="grid gap-3 md:grid-cols-2 md:items-start">
        {/* You have (basket) */}
        <Card className="overflow-visible">
          <CardContent className="py-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">You have</span>
              {basket.totalGears > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  Total {formatGears(basket.totalGears)}
                </span>
              )}
            </div>
            <div className="space-y-3">
              {have.map((line, i) => {
                const row = rowByName.get(line.name.trim().toLowerCase());
                const gpu = gearsPerUnit(row, basis);
                const q = Number.parseFloat(line.qty);
                return (
                  <div key={i} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Combobox
                        value={line.name}
                        onChange={(v) => setLineName(i, v)}
                        suggestions={suggestions}
                        placeholder="Search an item…"
                        className="h-9"
                      />
                      <QtyStepper value={line.qty} onChange={(v) => setLineQty(i, v)} />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0"
                        onClick={() => removeLine(i)}
                        disabled={have.length === 1 && !line.name.trim()}
                        aria-label="Remove item"
                        title="Remove item"
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                    {line.name.trim() && row && gpu != null && (
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-1 text-xs text-muted-foreground">
                        <span className="tabular-nums">
                          {formatGears(gpu)} / unit
                          {q > 0 && <> · {formatGears(gpu * q)} total</>}
                        </span>
                        <TrendIndicator trend={row.trend} />
                        <ConfidenceBadge soldCount={row.soldCount} />
                      </div>
                    )}
                    {line.name.trim() && row && gpu == null && (
                      <p className="pl-1 text-xs text-destructive">
                        No price data in this time range.
                      </p>
                    )}
                    {line.name.trim() && !row && (
                      <p className="pl-1 text-xs text-muted-foreground">
                        No match — pick one from the list.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={addLine}>
                <Plus className="h-4 w-4" aria-hidden /> Add item
              </Button>
              {canSwap && (
                <Button variant="ghost" size="sm" onClick={swap} title="Swap with target">
                  <ArrowLeftRight className="h-4 w-4" aria-hidden /> Swap
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* You want (target) */}
        <Card className="overflow-visible">
          <CardContent className="py-4 space-y-3">
            <span className="text-sm font-medium text-muted-foreground">You want</span>
            <Combobox
              value={wantName}
              onChange={setWantName}
              suggestions={suggestions}
              placeholder="Search a target item…"
              className="h-9"
            />
            {wantName.trim() && wantRow && <ItemStatsLine row={wantRow} basis={basis} />}
            {wantName.trim() && !wantRow && (
              <p className="text-sm text-muted-foreground">
                No item matches “{wantName.trim()}”. Pick one from the list.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Result */}
      {range && wantRow && basket.totalGears > 0 ? (
        <Card>
          <CardContent className="py-5 space-y-3">
            <div className="text-center">
              <div className="text-sm text-muted-foreground">
                {basket.lines.length === 1
                  ? `${formatQty(basket.lines[0].qty)} × ${basket.lines[0].name}`
                  : `${basket.lines.length} items · ${formatGears(basket.totalGears)}`}
              </div>
              <div className="text-3xl font-semibold tabular-nums">
                ≈ {formatQty(range.typ)} {wantRow.name}
              </div>
              {showBand(range) && (
                <div className="text-sm text-muted-foreground tabular-nums">
                  range {formatQty(range.low)}–{formatQty(range.high)} {wantRow.name}
                </div>
              )}
            </div>

            {basket.lines.length > 1 && (
              <div className="rounded-md border divide-y text-sm">
                {basket.lines.map((l) => (
                  <div key={l.name} className="flex items-center justify-between px-3 py-1.5">
                    <span>
                      {formatQty(l.qty)} × {l.name}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {formatGears(l.gears)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 text-center text-sm">
              <div className="rounded-md border py-2">
                <div className="text-muted-foreground">You give</div>
                <div className="font-medium tabular-nums">{formatGears(basket.totalGears)}</div>
              </div>
              <div className="rounded-md border py-2">
                <div className="text-muted-foreground">You get</div>
                <div className="font-medium tabular-nums">
                  ≈ {formatQty(range.typ)} {wantRow.name}
                </div>
              </div>
            </div>

            {basket.lines.length === 1 &&
              gearsPerUnit(basket.lines[0].row, basis) != null &&
              gearsPerUnit(wantRow, basis) != null && (
                <p className="text-center text-sm text-muted-foreground tabular-nums">
                  1 {basket.lines[0].name} ≈{" "}
                  {formatQty(
                    gearsPerUnit(basket.lines[0].row, basis)! / gearsPerUnit(wantRow, basis)!,
                  )}{" "}
                  {wantRow.name} · 1 {wantRow.name} ≈{" "}
                  {formatQty(
                    gearsPerUnit(wantRow, basis)! / gearsPerUnit(basket.lines[0].row, basis)!,
                  )}{" "}
                  {basket.lines[0].name}
                </p>
              )}

            <p className="text-center text-xs text-muted-foreground">
              {wantRow.activeListings.toLocaleString()} {wantRow.name} listed right now
              {wantRow.medianTimeToSellHours != null &&
                ` · typically sells in ~${formatRealTimeToSell(wantRow.medianTimeToSellHours)}`}
              .
            </p>

            {basket.incomplete && (
              <p className="text-center text-xs text-muted-foreground">
                Some items in your basket couldn’t be priced and were skipped.
              </p>
            )}
            {(wantRow.confidence === "low" ||
              basket.lines.some((l) => l.row.confidence === "low")) && (
              <p className="text-center text-xs text-destructive">
                One or more items have few recorded sales, so this estimate may be unreliable.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Add the items you have and pick a target item to see the exchange estimate.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

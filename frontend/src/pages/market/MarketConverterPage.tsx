// Item Converter — a barter/exchange calculator for the Auction House.
//
// Every item on the Auction House is priced in Rusty Gears (⚙), so the exchange
// rate between any two items is simply the ratio of their per-unit gear prices.
// Pick an item you *have* (and a quantity) plus an item you *want*, and this
// page shows the equivalent quantity along with the gear value of each side —
// e.g. how much resin ≈ one gold ingot.
//
// The medians come from `computeMarketInsights` (the same windowed aggregation
// the Insights page uses), so the "Time range" and "Price basis" controls both
// change the rate. The conversion math is isolated in `computeExchange` so a
// future multi-item "basket" mode can sum gear values across several rows.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuctionListings, formatGears } from "@/lib/auction";
import { INSIGHTS_WINDOWS, computeMarketInsights, confidenceFor } from "./useMarketInsights";
import { useMarketWindow } from "./useMarketWindow";
import type { ConfidenceTier, InsightsRow } from "@/models/auction";

// --------------------------------------------------------------------------- //
// Conversion math (pure — basket-mode ready)
// --------------------------------------------------------------------------- //

/** Which figure from a row's per-unit price distribution drives the rate. */
export type PriceBasis = "median" | "mean" | "p25" | "p75";

const BASIS_OPTIONS: { value: PriceBasis; label: string; hint: string }[] = [
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

interface ConverterState {
  haveName: string;
  wantName: string;
  qty: string;
  basis: PriceBasis;
}

const CONVERTER_STORAGE_KEY = "market.converter";
const VALID_BASIS = new Set<PriceBasis>(["median", "mean", "p25", "p75"]);

function loadConverterState(): ConverterState {
  const fallback: ConverterState = { haveName: "", wantName: "", qty: "1", basis: "median" };
  try {
    const raw = localStorage.getItem(CONVERTER_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ConverterState>;
    return {
      haveName: typeof parsed.haveName === "string" ? parsed.haveName : fallback.haveName,
      wantName: typeof parsed.wantName === "string" ? parsed.wantName : fallback.wantName,
      qty: typeof parsed.qty === "string" ? parsed.qty : fallback.qty,
      basis: parsed.basis && VALID_BASIS.has(parsed.basis) ? parsed.basis : fallback.basis,
    };
  } catch {
    return fallback;
  }
}

// Module-level cache: survives the page unmount/remount within a session even
// when localStorage is unavailable, and seeds each mount's initial state.
let converterCache = loadConverterState();

function persistConverter(patch: Partial<ConverterState>): void {
  converterCache = { ...converterCache, ...patch };
  try {
    localStorage.setItem(CONVERTER_STORAGE_KEY, JSON.stringify(converterCache));
  } catch {
    /* ignore persistence failures */
  }
}

/** Per-unit gear price for a row under the chosen basis, or `null` when the
 * item has no usable sold-price data in the current window. */
export function gearsPerUnit(row: InsightsRow | undefined, basis: PriceBasis): number | null {
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
// One "have" / "want" item side
// --------------------------------------------------------------------------- //

interface ItemSideProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  row: InsightsRow | undefined;
  basis: PriceBasis;
  /** Optional quantity input (only on the "have" side). */
  qty?: string;
  onQtyChange?: (v: string) => void;
}

function ItemSide({
  label,
  value,
  onChange,
  suggestions,
  row,
  basis,
  qty,
  onQtyChange,
}: ItemSideProps) {
  const gpu = gearsPerUnit(row, basis);
  const resolved = value.trim().length > 0 && row != null;
  const noData = resolved && gpu == null;

  return (
    <Card className="h-full overflow-visible">
      <CardContent className="py-4 space-y-3">
        <div className="text-sm font-medium text-muted-foreground">{label}</div>
        <div className="flex items-center gap-2">
          <Combobox
            value={value}
            onChange={onChange}
            suggestions={suggestions}
            placeholder="Search an item…"
            className="h-9"
          />
          {onQtyChange && (
            <input
              type="number"
              min={0}
              inputMode="decimal"
              value={qty}
              onChange={(e) => onQtyChange(e.target.value)}
              aria-label="Quantity"
              className="h-9 w-20 shrink-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
            />
          )}
        </div>

        {resolved && !noData && row && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{formatGears(gpu!)} / unit</span>
            <ConfidenceBadge soldCount={row.soldCount} />
            <Link
              to={`/market/items/${row.itemId}`}
              className="text-xs text-primary hover:underline"
            >
              Details
            </Link>
          </div>
        )}
        {noData && (
          <p className="text-sm text-destructive">
            No sold-price data for this item in the selected time range. Try a wider range.
          </p>
        )}
        {value.trim().length > 0 && row == null && (
          <p className="text-sm text-muted-foreground">
            No item matches “{value.trim()}”. Pick one from the list.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------- //
// Page
// --------------------------------------------------------------------------- //

export function MarketConverterPage() {
  const { data: listings, isPending, isError } = useAuctionListings();

  const [windowKey, setWindowKey] = useMarketWindow();
  const [basis, setBasisRaw] = useState<PriceBasis>(converterCache.basis);
  const [haveName, setHaveNameRaw] = useState(converterCache.haveName);
  const [wantName, setWantNameRaw] = useState(converterCache.wantName);
  const [qty, setQtyRaw] = useState(converterCache.qty);

  // Setters that also persist, so the selection survives leaving and returning.
  const setBasis = (v: PriceBasis) => {
    setBasisRaw(v);
    persistConverter({ basis: v });
  };
  const setHaveName = (v: string) => {
    setHaveNameRaw(v);
    persistConverter({ haveName: v });
  };
  const setWantName = (v: string) => {
    setWantNameRaw(v);
    persistConverter({ wantName: v });
  };
  const setQty = (v: string) => {
    setQtyRaw(v);
    persistConverter({ qty: v });
  };

  const windowDays = useMemo(
    () => INSIGHTS_WINDOWS.find((w) => w.key === windowKey)?.days ?? null,
    [windowKey],
  );

  const insights = useMemo(
    () => (listings && listings.length ? computeMarketInsights(listings, windowDays) : null),
    [listings, windowDays],
  );

  // Resolve item names to their best insights row. Item names can repeat across
  // ids, so keep the row with the most sales (the most reliable price signal).
  const { rowByName, suggestions } = useMemo(() => {
    const byName = new Map<string, InsightsRow>();
    if (insights) {
      for (const row of insights.rows) {
        if (row.soldCount <= 0 || row.priceStats == null) continue;
        const key = row.name.toLowerCase();
        const existing = byName.get(key);
        if (!existing || row.soldCount > existing.soldCount) byName.set(key, row);
      }
    }
    const names = Array.from(byName.values())
      .map((r) => r.name)
      .sort((a, b) => a.localeCompare(b));
    return { rowByName: byName, suggestions: names };
  }, [insights]);

  const haveRow = rowByName.get(haveName.trim().toLowerCase());
  const wantRow = rowByName.get(wantName.trim().toLowerCase());
  const qtyNum = Number.parseFloat(qty);

  const exchange = useMemo(
    () => computeExchange(haveRow, wantRow, qtyNum, basis),
    [haveRow, wantRow, qtyNum, basis],
  );

  const swap = () => {
    setHaveName(wantName);
    setWantName(haveName);
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
          Estimate how much of one item barters for another, using Auction House prices in Rusty
          Gears (⚙).
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
          <Select value={basis} onValueChange={(v) => setBasis(v as PriceBasis)}>
            <SelectTrigger size="sm" className="w-44">
              <SelectValue />
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
      </div>

      {/* Item pickers */}
      <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr] md:items-stretch">
        <ItemSide
          label="You have"
          value={haveName}
          onChange={setHaveName}
          suggestions={suggestions}
          row={haveRow}
          basis={basis}
          qty={qty}
          onQtyChange={setQty}
        />
        <div className="flex items-center justify-center">
          <Button
            variant="outline"
            size="icon"
            onClick={swap}
            aria-label="Swap items"
            title="Swap items"
          >
            <ArrowLeftRight className="h-4 w-4 md:rotate-0 rotate-90" aria-hidden />
          </Button>
        </div>
        <ItemSide
          label="You want"
          value={wantName}
          onChange={setWantName}
          suggestions={suggestions}
          row={wantRow}
          basis={basis}
        />
      </div>

      {/* Result */}
      {exchange && haveRow && wantRow ? (
        <Card>
          <CardContent className="py-5 space-y-3">
            <div className="text-center">
              <div className="text-sm text-muted-foreground">
                {formatQty(qtyNum)} × {haveRow.name}
              </div>
              <div className="text-3xl font-semibold tabular-nums">
                ≈ {formatQty(exchange.wantUnits)} {wantRow.name}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-center text-sm">
              <div className="rounded-md border py-2">
                <div className="text-muted-foreground">You give</div>
                <div className="font-medium tabular-nums">{formatGears(exchange.fromGears)}</div>
              </div>
              <div className="rounded-md border py-2">
                <div className="text-muted-foreground">You get</div>
                <div className="font-medium tabular-nums">
                  {formatGears(exchange.wantUnits * exchange.toGpu)}
                </div>
              </div>
            </div>
            <p className="text-center text-sm text-muted-foreground">
              1 {haveRow.name} ≈ {formatQty(exchange.fromGpu / exchange.toGpu)} {wantRow.name}
              {" · "}1 {wantRow.name} ≈ {formatQty(exchange.toGpu / exchange.fromGpu)}{" "}
              {haveRow.name}
            </p>
            {(haveRow.confidence === "low" || wantRow.confidence === "low") && (
              <p className="text-center text-xs text-destructive">
                One or both items have few recorded sales, so this estimate may be unreliable.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Pick an item you have and an item you want to see the exchange estimate.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

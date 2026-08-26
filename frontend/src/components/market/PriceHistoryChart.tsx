// Expandable, hoverable price-history chart for a single item. Unlike the header
// sparkline (a shape-only cue built from a downsampled value array), this plots
// every real sale against its in-game sale time so a hover reads the exact price
// at an exact moment.

import { useMemo, useState } from "react";
import {
  ComposedChart,
  Line,
  Scatter,
  XAxis,
  YAxis,
  Tooltip as ChartTooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { Button } from "@/components/ui/button";
import { formatGears, percentileSorted } from "@/lib/auction";
import { formatGameDate, formatListingDate } from "../../components/market/VirtualListingsTable";

/** One sold sale: its in-game conclusion time, per-unit price, quantity, total
 * gears, and the real-world timestamp it was observed at (for the tooltip). */
export interface SalePoint {
  t: number;
  ppu: number;
  qty: number;
  price: number;
  observedUtc: string | null;
}

/** Simple trailing moving average over the last `window` samples, so the line
 * smooths out single-sale noise without lagging a fixed calendar period. */
function movingAverage(values: number[], window: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    out.push(sum / Math.min(i + 1, window));
  }
  return out;
}

// Y-axis ceiling for the expired-listings overlay, as a multiple of the median
// sale price (never below the highest real sale). Extreme asking prices above
// this are pinned to the top instead of stretching the whole chart.
const EXPIRED_CAP_MULTIPLE = 5;

export function PriceHistoryChart({
  points,
  expiredPoints,
  stackSize,
  defaultPerUnit,
  showUnsold,
  onShowUnsoldChange,
}: {
  points: SalePoint[];
  /** Expired-but-not-cancelled listings that never sold, plotted at their asking
   * price to reveal how much unsold supply sits above the sales cluster. */
  expiredPoints?: SalePoint[];
  stackSize: number;
  /** Seed the per-unit vs per-stack toggle from the page's own decision. */
  defaultPerUnit: boolean;
  /** Controlled "show unsold" state; when omitted the component keeps its own. */
  showUnsold?: boolean;
  onShowUnsoldChange?: (v: boolean) => void;
}) {
  const canStack = stackSize > 1;
  const [perUnit, setPerUnit] = useState(defaultPerUnit || !canStack);
  const [internalShowExpired, setInternalShowExpired] = useState(false);
  const showExpired = showUnsold ?? internalShowExpired;
  const setShowExpired = (v: boolean) =>
    onShowUnsoldChange ? onShowUnsoldChange(v) : setInternalShowExpired(v);
  const hasExpired = (expiredPoints?.length ?? 0) > 0;

  const { rows, chartData, median, min, max, cap, clampedCount } = useMemo(() => {
    const scale = perUnit ? 1 : stackSize || 1;
    const scaled = points.map((p) => p.ppu * scale);
    const ma = movingAverage(scaled, 7);
    const rows = points.map((p, i) => ({
      t: p.t,
      price: scaled[i],
      ma: ma[i],
      qty: p.qty,
      observedUtc: p.observedUtc,
    }));
    const sorted = [...scaled].sort((a, b) => a - b);
    const medianVal = percentileSorted(sorted, 0.5);
    const maxSale = sorted[sorted.length - 1] ?? 0;
    // A wildly overpriced expired listing (e.g. 12× the median) would otherwise
    // crush every real sale into a flat line. Cap the axis at a multiple of the
    // median — but never below the highest actual sale — and pin anything above
    // it to that ceiling so the outliers still register without dominating.
    const cap = Math.max(maxSale, medianVal * EXPIRED_CAP_MULTIPLE) || maxSale;
    let clampedCount = 0;
    const expiredRows =
      showExpired && expiredPoints
        ? expiredPoints.map((p) => {
            const value = p.ppu * scale;
            const clamped = cap > 0 && value > cap;
            if (clamped) clampedCount += 1;
            return {
              t: p.t,
              expired: clamped ? cap : value,
              expiredReal: value,
              clamped,
              qty: p.qty,
              observedUtc: p.observedUtc,
            };
          })
        : [];
    const chartData = [...rows, ...expiredRows].sort((a, b) => a.t - b.t);
    return {
      rows,
      chartData,
      median: medianVal,
      min: sorted[0] ?? 0,
      max: maxSale,
      cap,
      clampedCount,
    };
  }, [points, expiredPoints, showExpired, perUnit, stackSize]);

  const unit = perUnit ? "unit" : "stack";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Every recorded sale over the selected range, by in-game sale date. Hover a point for the
          exact price.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {hasExpired && (
            <Button
              size="sm"
              variant={showExpired ? "default" : "outline"}
              onClick={() => setShowExpired(!showExpired)}
              title="Overlay expired (unsold, not cancelled) listings at their asking price to gauge supply above current sales"
            >
              {showExpired ? "Hide unsold" : "Show unsold"}
            </Button>
          )}
          {canStack && (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant={perUnit ? "default" : "outline"}
                onClick={() => setPerUnit(true)}
              >
                Per unit
              </Button>
              <Button
                size="sm"
                variant={!perUnit ? "default" : "outline"}
                onClick={() => setPerUnit(false)}
              >
                Per stack
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 18, left: 4 }}>
            <XAxis
              dataKey="t"
              type="number"
              domain={["dataMin", "dataMax"]}
              scale="linear"
              tick={{ fontSize: 11 }}
              tickFormatter={(v: number) => formatGameDate(v)}
              minTickGap={40}
            />
            <YAxis
              tick={{ fontSize: 11 }}
              width={52}
              domain={showExpired && clampedCount > 0 ? [0, cap] : ["auto", "auto"]}
              allowDataOverflow
              tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
              label={{
                value: perUnit ? "Price / unit (gears)" : "Price / stack (gears)",
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
              labelFormatter={(label) => formatGameDate(Number(label))}
              formatter={(value, name, item) => {
                if (name === "7-sale avg")
                  return [`${formatGears(Number(value))} / ${unit}`, "7-sale avg"];
                const p = item?.payload as
                  | {
                      qty?: number;
                      observedUtc?: string | null;
                      expiredReal?: number;
                      clamped?: boolean;
                    }
                  | undefined;
                const obs = p?.observedUtc ? ` · seen ${formatListingDate(p.observedUtc)}` : "";
                if (name === "Unsold (expired)") {
                  // Show the true asking price even when the point is pinned to
                  // the capped ceiling.
                  const real = p?.expiredReal ?? Number(value);
                  const flag = p?.clamped ? " · capped" : "";
                  return [
                    `${formatGears(real)} / ${unit} · ×${p?.qty ?? "?"}${flag}${obs}`,
                    "Unsold",
                  ];
                }
                return [
                  `${formatGears(Number(value))} / ${unit} · ×${p?.qty ?? "?"}${obs}`,
                  "Sale",
                ];
              }}
            />
            <ReferenceLine y={median} stroke="#10b981" strokeDasharray="4 4" />
            <ReferenceLine y={min} stroke="#94a3b8" strokeDasharray="2 3" />
            <ReferenceLine y={max} stroke="#94a3b8" strokeDasharray="2 3" />
            {showExpired && (
              <Scatter
                dataKey="expired"
                fill="#ef4444"
                fillOpacity={0.55}
                shape="cross"
                name="Unsold (expired)"
                isAnimationActive={false}
              />
            )}
            <Scatter dataKey="price" fill="#6366f1" name="Sale" isAnimationActive={false} />
            <Line
              data={rows}
              type="monotone"
              dataKey="ma"
              stroke="#f59e0b"
              strokeWidth={2}
              dot={false}
              name="7-sale avg"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <li className="flex items-center gap-2">
          <span className="inline-block size-2 shrink-0 rounded-full bg-[#6366f1]" />
          <span>
            <span className="text-foreground">Sales</span> — each recorded sale, per {unit}.
          </span>
        </li>
        {showExpired && (
          <li className="flex items-center gap-2">
            <span className="inline-block size-2 shrink-0 rotate-45 bg-[#ef4444]/60" />
            <span>
              <span className="text-foreground">Unsold (expired)</span> — listings that expired at
              this asking price without selling. Many points above the sales cluster mean plenty of
              supply sellers would part with if buyers paid more.
              {clampedCount > 0 && (
                <>
                  {" "}
                  {clampedCount} priced above {EXPIRED_CAP_MULTIPLE}× the median{" "}
                  {clampedCount === 1 ? "is" : "are"} pinned to the top ({formatGears(cap)} / {unit}
                  ) — hover for the real price.
                </>
              )}
            </span>
          </li>
        )}
        <li className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-3 shrink-0 bg-[#f59e0b]" />
          <span>
            <span className="text-foreground">7-sale avg</span> — trailing average, smoothing noise.
          </span>
        </li>
        <li className="flex items-center gap-2">
          <span className="inline-block h-0 w-3 shrink-0 border-t-2 border-dashed border-[#10b981]" />
          <span>
            <span className="text-foreground">Median</span> {formatGears(median)} · range{" "}
            {formatGears(min)}–{formatGears(max)} / {unit}.
          </span>
        </li>
      </ul>
    </div>
  );
}

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
import { formatGameDate, formatListingDate } from "./VirtualListingsTable";

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

export function PriceHistoryChart({
  points,
  stackSize,
  defaultPerUnit,
}: {
  points: SalePoint[];
  stackSize: number;
  /** Seed the per-unit vs per-stack toggle from the page's own decision. */
  defaultPerUnit: boolean;
}) {
  const canStack = stackSize > 1;
  const [perUnit, setPerUnit] = useState(defaultPerUnit || !canStack);

  const { rows, median, min, max } = useMemo(() => {
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
    return {
      rows,
      median: percentileSorted(sorted, 0.5),
      min: sorted[0] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
    };
  }, [points, perUnit, stackSize]);

  const unit = perUnit ? "unit" : "stack";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Every recorded sale over the selected range, by in-game sale date. Hover a point for the
          exact price.
        </p>
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
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 18, left: 4 }}>
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
                const p = item?.payload as (typeof rows)[number] | undefined;
                const obs = p?.observedUtc ? ` · seen ${formatListingDate(p.observedUtc)}` : "";
                return [
                  `${formatGears(Number(value))} / ${unit} · ×${p?.qty ?? "?"}${obs}`,
                  "Sale",
                ];
              }}
            />
            <ReferenceLine y={median} stroke="#10b981" strokeDasharray="4 4" />
            <ReferenceLine y={min} stroke="#94a3b8" strokeDasharray="2 3" />
            <ReferenceLine y={max} stroke="#94a3b8" strokeDasharray="2 3" />
            <Scatter dataKey="price" fill="#6366f1" name="Sale" isAnimationActive={false} />
            <Line
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

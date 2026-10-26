// A collapsed-by-default chart for quenched tools/weapons: it buckets sold
// listings by their quench power (temper boost) so a seller can see how common
// each quench level is and what price each level typically fetches.

import { useMemo, useState } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  Cell,
  XAxis,
  YAxis,
  Tooltip as ChartTooltip,
  ResponsiveContainer,
} from "recharts";
import { ChevronDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatGears, percentileSorted } from "@/lib/market/auction";
import { quenchColor, QUENCH_TIERS } from "@/components/market/quenchColors";

/** One quenched tool observation feeding the chart. */
export interface QuenchPoint {
  /** Quench power as a fraction of base stats (0.25 = +25%). */
  quench: number;
  /** Per-unit sale/ask price in gears. */
  ppu: number;
  /** Whether this listing actually sold. */
  sold: boolean;
  /** Whether this listing expired unsold (not cancelled by the seller). */
  expired: boolean;
}

// Histogram resolution: 5%-wide quench-power buckets keep the natural quench
// clusters (≈10/20/25/37/50%) legible without over-smoothing them together.
const BIN_WIDTH = 0.05;

// Expired-supply columns: a cool shade for asks below the level's median
// (didn't sell even when cheap) and a warm one for asks above it (overpriced).
const EXPIRED_BELOW_COLOR = "#60a5fa";
const EXPIRED_ABOVE_COLOR = "#f87171";

interface Bin {
  key: number;
  label: string;
  midpoint: number;
  color: string;
  sold: number;
  medianPrice: number | null;
  /** Expired (unsold) listings that were asking above the level's median. */
  expiredAbove: number;
  /** Expired (unsold) listings that were asking at or below the median. */
  expiredBelow: number;
}

function medianOf(sortedAsc: number[]): number | null {
  return sortedAsc.length ? percentileSorted(sortedAsc, 0.5) : null;
}

function buildBins(points: QuenchPoint[]): Bin[] {
  // Overall sold median as a fallback reference, so expired asks in a bucket
  // that recorded no sale of its own can still be classified above/below.
  const overallMedian = medianOf(
    points
      .filter((p) => p.sold)
      .map((p) => p.ppu)
      .sort((a, b) => a - b),
  );

  const byBin = new Map<number, { sold: number[]; expired: number[] }>();
  for (const p of points) {
    const idx = Math.floor(p.quench / BIN_WIDTH);
    let bucket = byBin.get(idx);
    if (!bucket) {
      bucket = { sold: [], expired: [] };
      byBin.set(idx, bucket);
    }
    if (p.sold) bucket.sold.push(p.ppu);
    else if (p.expired) bucket.expired.push(p.ppu);
  }

  const bins: Bin[] = [];
  for (const [idx, bucket] of byBin) {
    const start = idx * BIN_WIDTH;
    const midpoint = start + BIN_WIDTH / 2;
    const medianPrice = medianOf(bucket.sold.sort((a, b) => a - b));
    // Prefer this level's own median; fall back to the overall median so a
    // bucket with only expired listings can still be split.
    const reference = medianPrice ?? overallMedian;
    let expiredAbove = 0;
    let expiredBelow = 0;
    if (reference != null) {
      for (const ppu of bucket.expired) {
        if (ppu > reference) expiredAbove += 1;
        else expiredBelow += 1;
      }
    }
    bins.push({
      key: idx,
      label: `${Math.round(start * 100)}–${Math.round((start + BIN_WIDTH) * 100)}%`,
      midpoint,
      color: quenchColor(midpoint),
      sold: bucket.sold.length,
      medianPrice,
      expiredAbove,
      expiredBelow,
    });
  }
  return bins.sort((a, b) => a.key - b.key);
}

export function QuenchPriceChart({ points }: { points: QuenchPoint[] }) {
  const [expanded, setExpanded] = useState(true);
  const bins = useMemo(() => buildBins(points), [points]);
  const soldTotal = useMemo(() => points.filter((p) => p.sold).length, [points]);
  const expiredTotal = useMemo(() => points.filter((p) => p.expired).length, [points]);

  // Tiers actually present, so the legend only lists quench levels on the chart.
  const tiersPresent = useMemo(() => {
    const seen = new Set(bins.map((b) => quenchColor(b.midpoint)));
    return QUENCH_TIERS.filter((t) => seen.has(t.color));
  }, [bins]);

  return (
    <Card>
      <CardContent className="py-4">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex w-full cursor-pointer items-center justify-between gap-2 text-left"
        >
          <div>
            <h2 className="font-semibold">Price by quench level</h2>
            <p className="text-xs text-muted-foreground">
              How many quenched tools sold at each temper boost, the price each level fetches, and
              how much unsold supply expired above vs below that price.
            </p>
          </div>
          <ChevronDown
            className={`size-5 shrink-0 text-muted-foreground transition-transform duration-300 ${
              expanded ? "rotate-180" : ""
            }`}
            aria-hidden
          />
        </button>

        {expanded && (
          <div className="mt-4">
            <div className="h-72 text-foreground">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={bins} margin={{ top: 8, right: 12, bottom: 24, left: 4 }}>
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11 }}
                    label={{
                      value: "Quench power (temper boost)",
                      position: "insideBottom",
                      offset: -4,
                      fontSize: 11,
                    }}
                  />
                  <YAxis
                    yAxisId="count"
                    tick={{ fontSize: 11 }}
                    width={40}
                    allowDecimals={false}
                    label={{
                      value: "Tools (count)",
                      angle: -90,
                      position: "insideLeft",
                      fontSize: 11,
                    }}
                  />
                  <YAxis
                    yAxisId="price"
                    orientation="right"
                    tick={{ fontSize: 11 }}
                    width={52}
                    tickFormatter={(v: number) => formatGears(v)}
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
                    labelFormatter={(label) => `Quench ${label}`}
                    formatter={(value, name) => {
                      if (name === "Median price")
                        return [`${formatGears(Number(value))} / unit`, name];
                      return [value, name];
                    }}
                  />
                  <Bar
                    yAxisId="count"
                    dataKey="sold"
                    name="Sold tools"
                    radius={[2, 2, 0, 0]}
                    isAnimationActive={false}
                  >
                    {bins.map((b) => (
                      <Cell key={b.key} fill={b.color} />
                    ))}
                  </Bar>
                  <Bar
                    yAxisId="count"
                    dataKey="expiredBelow"
                    stackId="expired"
                    name="Expired · below median"
                    fill={EXPIRED_BELOW_COLOR}
                    isAnimationActive={false}
                  />
                  <Bar
                    yAxisId="count"
                    dataKey="expiredAbove"
                    stackId="expired"
                    name="Expired · above median"
                    fill={EXPIRED_ABOVE_COLOR}
                    radius={[2, 2, 0, 0]}
                    isAnimationActive={false}
                  />
                  <Line
                    yAxisId="price"
                    type="monotone"
                    dataKey="medianPrice"
                    name="Median price"
                    stroke="currentColor"
                    strokeWidth={2}
                    connectNulls
                    dot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 space-y-1.5 text-xs text-muted-foreground">
              <p>
                Coloured bars count the <span className="text-foreground">{soldTotal}</span> sold
                quenched tools in each boost range and the{" "}
                <span className="text-foreground">line</span> is their median sold price. Beside
                them, the <span className="text-foreground">{expiredTotal}</span> expired (unsold)
                listings are stacked and split by whether they were asking above or below that
                level&apos;s median — tall <span className="text-foreground">above-median</span>{" "}
                supply means sellers overpriced, while{" "}
                <span className="text-foreground">below-median</span> expiries point to weak demand.
                Only quenched tool heads and finished tools are included.
              </p>
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {tiersPresent.map((t) => (
                  <li key={t.label} className="flex items-center gap-2">
                    <span
                      className="inline-block size-2 shrink-0 rounded-sm"
                      style={{ backgroundColor: t.color }}
                    />
                    <span>Sold · {t.label}</span>
                  </li>
                ))}
                <li className="flex items-center gap-2">
                  <span
                    className="inline-block size-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: EXPIRED_ABOVE_COLOR }}
                  />
                  <span>Expired · above median</span>
                </li>
                <li className="flex items-center gap-2">
                  <span
                    className="inline-block size-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: EXPIRED_BELOW_COLOR }}
                  />
                  <span>Expired · below median</span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="inline-block h-0.5 w-3 shrink-0 bg-foreground" />
                  <span>
                    <span className="text-foreground">Median price</span> at each level.
                  </span>
                </li>
              </ul>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

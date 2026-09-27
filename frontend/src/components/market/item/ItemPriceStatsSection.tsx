import type { PriceStats } from "@/models/auction";
import { Card, CardContent } from "@/components/ui/card";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  ComposedChart,
  Line,
  ReferenceLine,
} from "recharts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { buildHistogram } from "@/lib/market/buildHistogram";
import { useState, useMemo } from "react";

/** Selectable histogram resolutions. More bins = smaller price step, which
 * resolves tight clusters when an item has big price swings. */
const BIN_OPTIONS = [
  { label: "Coarse", bins: 12 },
  { label: "Standard", bins: 24 },
  { label: "Fine", bins: 48 },
  { label: "Ultra-fine", bins: 96 },
] as const;

export function ItemPriceStatsSection({
  ps,
  perUnitUseful,
  unitWord,
  chartPrices,
  markerValue,
  priceModeWeighted,
}: {
  ps: PriceStats | null;
  perUnitUseful: boolean;
  unitWord: string;
  chartPrices: number[];
  markerValue: number | null;
  priceModeWeighted: boolean;
}) {
  // Histogram bin count. Higher = finer price buckets (smaller per-unit step).
  const [bins, setBins] = useState(24);
  const histogram = useMemo(
    () => buildHistogram(chartPrices, bins, markerValue ?? undefined),
    [chartPrices, bins, markerValue],
  );
  if (!ps) return null;
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h2 className="font-semibold">
            {perUnitUseful
              ? `Price-per-${unitWord} distribution (sold)`
              : "Price-per-stack distribution (sold)"}
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              p25 {histogram.p25.toLocaleString()} · median {histogram.median.toLocaleString()} ·
              p75 {histogram.p75.toLocaleString()}
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
            <ComposedChart data={histogram.bars} margin={{ top: 4, right: 8, bottom: 18, left: 4 }}>
              <XAxis
                dataKey="bucket"
                tick={{ fontSize: 11 }}
                label={{
                  value: perUnitUseful ? `Price / ${unitWord} (gears)` : "Price / stack (gears)",
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
              <ReferenceLine x={histogram.medianBucket} stroke="#10b981" strokeDasharray="4 4" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 space-y-1.5 text-xs text-muted-foreground">
          {!perUnitUseful && (
            <p>
              This item almost always sells as full stacks, so per-unit prices round below 1 gear
              and aren&apos;t meaningful. The chart and fair price below use the{" "}
              <span className="text-foreground">whole-stack</span> price instead.
            </p>
          )}
          <p>
            Each bar counts how many <span className="text-foreground">sold</span> listings traded
            at that price per {perUnitUseful ? "unit" : "stack"} (x-axis, in gears). Taller bars are
            the more common prices — so the tall cluster shows what most players actually paid.
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
  );
}

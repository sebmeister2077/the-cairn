import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  XAxis,
  YAxis,
  Tooltip as ChartTooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatGears } from "@/lib/auction";
import { formatGameDate } from "./VirtualListingsTable";
import type { MarketTimePoint } from "@/models/auction";

// The metrics a viewer can chart over in-game time. `gears` flags currency
// values so the axis/tooltip render with the gears formatter; `pct` flags a
// 0–1 ratio shown as a percentage.
interface MetricDef {
  key: string;
  label: string;
  color: string;
  /** Pull the per-bucket value from a time point (null = skip the point). */
  value: (p: MarketTimePoint) => number | null;
  gears?: boolean;
  pct?: boolean;
  /** Ratios can't be summed, so they're excluded from the cumulative view. */
  noCumulative?: boolean;
}

const METRICS: MetricDef[] = [
  {
    key: "gearsTraded",
    label: "Gears traded",
    color: "#f59e0b",
    value: (p) => p.gearsTraded,
    gears: true,
  },
  {
    key: "gearsRemoved",
    label: "Gears removed",
    color: "#dc2626",
    value: (p) => p.feesPaid + p.depositFeesPaid + p.deliveryFeesPaid,
    gears: true,
  },
  { key: "sold", label: "Items sold", color: "#10b981", value: (p) => p.sold },
  { key: "posted", label: "Auctions posted", color: "#3b82f6", value: (p) => p.posted },
  { key: "unitsSold", label: "Units sold", color: "#06b6d4", value: (p) => p.unitsSold },
  {
    key: "sellThrough",
    label: "Sell-through",
    color: "#8b5cf6",
    value: (p) => p.sellThrough,
    pct: true,
    noCumulative: true,
  },
  { key: "feesPaid", label: "Fees paid", color: "#ef4444", value: (p) => p.feesPaid, gears: true },
  {
    key: "depositFeesPaid",
    label: "Deposit fees",
    color: "#ec4899",
    value: (p) => p.depositFeesPaid,
    gears: true,
  },
  {
    key: "deliveryFeesPaid",
    label: "Delivery fees",
    color: "#84cc16",
    value: (p) => p.deliveryFeesPaid,
    gears: true,
  },
  {
    key: "uniqueSellers",
    label: "Sellers",
    color: "#f97316",
    value: (p) => p.uniqueSellers,
  },
  { key: "uniqueBuyers", label: "Active buyers", color: "#6366f1", value: (p) => p.uniqueBuyers },
  { key: "missing", label: "Missing auctions", color: "#94a3b8", value: (p) => p.missing },
  { key: "unrecorded", label: "Unrecorded outcome", color: "#a3a3a3", value: (p) => p.unrecorded },
];

function compactNumber(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1000) return `${Math.round(v / 1000)}k`;
  return String(Math.round(v));
}

export function MarketTrendsChart({
  series,
  recordingStart,
}: {
  series: MarketTimePoint[];
  recordingStart?: number | null;
}) {
  const [metricKey, setMetricKey] = useState(METRICS[0].key);
  const [cumulative, setCumulative] = useState(false);

  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];
  const showCumulative = cumulative && !metric.noCumulative;

  const data = useMemo(() => {
    let running = 0;
    return series.map((p) => {
      const raw = metric.value(p);
      let v = raw ?? 0;
      if (showCumulative) {
        running += v;
        v = running;
      }
      return {
        gameHours: p.gameHours,
        label: formatGameDate(p.gameHours),
        value: raw == null && !showCumulative ? null : v,
      };
    });
  }, [series, metric, showCumulative]);

  // Snap the real-world "started recording" moment onto the categorical
  // (monthly) x-axis by picking the bucket whose in-game clock is closest.
  const recordingLabel = useMemo(() => {
    if (recordingStart == null || series.length === 0) return null;
    let best = series[0];
    for (const p of series) {
      if (Math.abs(p.gameHours - recordingStart) < Math.abs(best.gameHours - recordingStart)) {
        best = p;
      }
    }
    return formatGameDate(best.gameHours);
  }, [recordingStart, series]);

  const fmt = (v: number) =>
    metric.pct ? `${(v * 100).toFixed(0)}%` : metric.gears ? formatGears(v) : v.toLocaleString();

  if (series.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Not enough dated auctions to chart market trends.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-medium">Market trends</div>
            <p className="text-xs text-muted-foreground">
              {showCumulative ? "Cumulative" : "Per in-game month"}, by auction posting date.
            </p>
          </div>
          <Button
            size="sm"
            variant={showCumulative ? "default" : "outline"}
            disabled={metric.noCumulative}
            onClick={() => setCumulative((c) => !c)}
            title={metric.noCumulative ? "Ratios can't be accumulated" : undefined}
          >
            {showCumulative ? "Cumulative" : "Per month"}
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {METRICS.map((m) => (
            <Button
              key={m.key}
              size="sm"
              variant={m.key === metricKey ? "default" : "outline"}
              className="h-7 px-2.5 text-xs"
              onClick={() => setMetricKey(m.key)}
            >
              {m.label}
            </Button>
          ))}
        </div>

        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 18, left: 4 }}>
              <defs>
                <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={metric.color} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={metric.color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
                minTickGap={28}
              />
              <YAxis
                tick={{ fontSize: 11 }}
                width={48}
                allowDecimals={metric.pct}
                domain={metric.pct ? [0, 1] : [0, "auto"]}
                ticks={metric.pct ? [0, 0.25, 0.5, 0.75, 1] : undefined}
                tickFormatter={(v: number) =>
                  metric.pct ? `${Math.round(v * 100)}%` : compactNumber(v)
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
                formatter={(value) => [fmt(Number(value)), metric.label]}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={metric.color}
                strokeWidth={2}
                fill="url(#trendFill)"
                connectNulls
                dot={false}
                name={metric.label}
              />
              {/* Drawn last so it sits on top of the area fill. `currentColor`
                  (the inherited theme text color) keeps the line and its label
                  legible in both light and dark mode — CSS `var()` does NOT
                  resolve inside SVG presentation attributes, which is why a
                  `hsl(var(--…))` fill rendered black in dark mode. */}
              {recordingLabel != null && (
                <ReferenceLine
                  x={recordingLabel}
                  stroke="currentColor"
                  strokeDasharray="5 4"
                  strokeWidth={2}
                  ifOverflow="extendDomain"
                  label={{
                    value: "Started recording",
                    position: "insideTopRight",
                    fontSize: 10,
                    fill: "currentColor",
                  }}
                />
              )}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import type { UsageGranularity } from "@/lib/api";

/**
 * Generic bucketed bar chart for usage data.
 *
 * Pivots the long-form rows ``{ <xKey>, <seriesKey>, <yKey> }`` into the
 * wide shape Recharts expects, one stacked/grouped ``Bar`` per series.
 * Series colors come from a small categorical palette and stay consistent
 * across re-renders because they're keyed by series name (sorted).
 */
interface RowLike {
  [key: string]: string | number | boolean | null | undefined;
}

interface TimeSeriesChartProps {
  data: RowLike[];
  xKey: string;
  yKey: string;
  seriesKey: string;
  stacked?: boolean;
  granularity?: UsageGranularity;
  height?: number;
  /** When true, overlay a centered moving-average line of the bucket totals. */
  showTrend?: boolean;
  /** Window size (in buckets) for the moving average. Default 7. */
  trendWindow?: number;
}

// Reasonably color-blind-friendly categorical palette.
const PALETTE = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#f97316",
  "#6366f1",
];

export function TimeSeriesChart({
  data,
  xKey,
  yKey,
  seriesKey,
  stacked = false,
  granularity = "day",
  height = 280,
  showTrend = false,
  trendWindow = 7,
}: TimeSeriesChartProps) {
  const { wide, series, effectiveWindow } = useMemo(() => {
    const seriesSet = new Set<string>();
    const byBucket = new Map<string, Record<string, number | string>>();
    for (const r of data) {
      const bucket = String(r[xKey] ?? "");
      const s = String(r[seriesKey] ?? "");
      const v = Number(r[yKey] ?? 0);
      if (!bucket) continue;
      seriesSet.add(s);
      let row = byBucket.get(bucket);
      if (!row) {
        row = { __bucket: bucket };
        byBucket.set(bucket, row);
      }
      row[s] = ((row[s] as number) ?? 0) + v;
    }
    const wide = Array.from(byBucket.values()).sort((a, b) =>
      String(a.__bucket).localeCompare(String(b.__bucket)),
    );
    const seriesList = Array.from(seriesSet).sort();
    // Shrink the requested window to whatever's actually available so the
    // trend line renders even on short ranges (e.g. 24h / 1 bucket would
    // otherwise be hidden by a fixed 7-bucket gate).
    const effectiveWindow = Math.max(1, Math.min(trendWindow, wide.length));
    // Compute per-bucket total + centered moving average for the trend line.
    const totals = wide.map((row) => seriesList.reduce((acc, s) => acc + Number(row[s] ?? 0), 0));
    const half = Math.floor(effectiveWindow / 2);
    for (let i = 0; i < wide.length; i++) {
      const lo = Math.max(0, i - half);
      const hi = Math.min(totals.length, i + half + 1);
      let sum = 0;
      for (let j = lo; j < hi; j++) sum += totals[j];
      wide[i].__trend = sum / (hi - lo);
      wide[i].__total = totals[i];
    }
    return { wide, series: seriesList, effectiveWindow };
  }, [data, xKey, yKey, seriesKey, trendWindow]);

  if (wide.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-10 text-center">No data in window.</div>
    );
  }

  const trendVisible = showTrend && wide.length >= 2;
  const trendLabel = `Trend (${effectiveWindow}-bucket avg)`;
  const isDark = useIsDarkTheme();
  // SVG stroke attributes don't resolve CSS ``var(--…)`` references, so
  // we have to pick a concrete hex per theme. Slate-900 / slate-100 work
  // well on the default shadcn palettes.
  const trendStroke = isDark ? "#f1f5f9" : "#0f172a";
  const gridStroke = isDark ? "#1f2937" : "#e5e7eb";
  // Tooltip card uses inline CSS, where ``var()`` *does* work — so we
  // can defer to the theme tokens directly.
  const tooltipStyle = {
    fontSize: 12,
    background: "hsl(var(--popover))",
    color: "hsl(var(--popover-foreground))",
    border: "1px solid hsl(var(--border))",
    borderRadius: 6,
  } as const;
  const tooltipLabelStyle = { color: "hsl(var(--popover-foreground))" } as const;
  const tooltipItemStyle = { color: "hsl(var(--popover-foreground))" } as const;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={wide} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        <CartesianGrid stroke={gridStroke} vertical={false} />
        <XAxis
          dataKey="__bucket"
          tickFormatter={(v) => formatBucket(String(v), granularity)}
          fontSize={11}
        />
        <YAxis fontSize={11} allowDecimals={false} />
        <Tooltip
          labelFormatter={(v) => formatBucket(String(v), granularity)}
          contentStyle={tooltipStyle}
          labelStyle={tooltipLabelStyle}
          itemStyle={tooltipItemStyle}
          cursor={{ fill: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)" }}
          formatter={(value, name) => {
            if (name === "__trend") {
              return [Number(value).toFixed(1), trendLabel.toLowerCase()];
            }
            return [value, name];
          }}
        />
        <Legend
          wrapperStyle={{ fontSize: 12 }}
          formatter={(value) => (value === "__trend" ? trendLabel : value)}
        />
        {series.map((s, i) => (
          <Bar
            key={s}
            dataKey={s}
            stackId={stacked ? "stack" : undefined}
            fill={PALETTE[i % PALETTE.length]}
          />
        ))}
        {trendVisible ? (
          <Line
            type="monotone"
            dataKey="__trend"
            stroke={trendStroke}
            strokeOpacity={0.9}
            strokeWidth={2}
            strokeDasharray="4 4"
            dot={false}
            activeDot={false}
            isAnimationActive={false}
          />
        ) : null}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function formatBucket(iso: string, gran: UsageGranularity): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (gran === "hour") return d.toISOString().slice(11, 16);
  if (gran === "week") {
    // ISO week start (yyyy-mm-dd is enough).
    return d.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Track whether the document is currently in dark mode (shadcn convention:
 * a ``dark`` class on ``<html>``). Re-renders when the class flips.
 */
function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = useState(() =>
    typeof document !== "undefined" ? document.documentElement.classList.contains("dark") : false,
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const update = () => setIsDark(root.classList.contains("dark"));
    update();
    const obs = new MutationObserver(update);
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

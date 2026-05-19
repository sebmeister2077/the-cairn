import { useMemo } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
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
}: TimeSeriesChartProps) {
  const { wide, series } = useMemo(() => {
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
    return { wide, series: Array.from(seriesSet).sort() };
  }, [data, xKey, yKey, seriesKey]);

  if (wide.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-10 text-center">No data in window.</div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={wide} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        <CartesianGrid stroke="#e5e7eb" vertical={false} />
        <XAxis
          dataKey="__bucket"
          tickFormatter={(v) => formatBucket(String(v), granularity)}
          fontSize={11}
        />
        <YAxis fontSize={11} allowDecimals={false} />
        <Tooltip
          labelFormatter={(v) => formatBucket(String(v), granularity)}
          contentStyle={{ fontSize: 12 }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {series.map((s, i) => (
          <Bar
            key={s}
            dataKey={s}
            stackId={stacked ? "stack" : undefined}
            fill={PALETTE[i % PALETTE.length]}
          />
        ))}
      </BarChart>
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

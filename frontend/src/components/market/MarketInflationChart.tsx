import {
  Area,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as ChartTooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import type { PriceIndexTrendPoint } from "@/models/auction";

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface Row {
  date: string;
  index: number;
  band: [number, number];
  basketItems: number;
}

// The chart shows a single line — the price level relative to the start of
// recording (100 = "prices when tracking began") — inside a shaded 95%
// confidence band, with a dashed baseline at 100 so "above the line = pricier".
export function MarketInflationChart({ trend }: { trend: PriceIndexTrendPoint[] }) {
  if (trend.length < 2) return null;
  const rows: Row[] = trend.map((p) => ({
    date: shortDate(p.startUtc),
    index: p.index,
    band: [p.ciLow, p.ciHigh],
    basketItems: p.basketItems,
  }));

  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-1 font-medium">Price level over time</div>
        <p className="mb-3 text-sm text-muted-foreground">
          100 = average prices when tracking began. Higher means things cost more Rusty Gears. The
          shaded area is how uncertain each point is.
        </p>
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="date" tick={{ fontSize: 12 }} />
            <YAxis
              tick={{ fontSize: 12 }}
              domain={["dataMin - 5", "dataMax + 5"]}
              tickFormatter={(v: number) => String(Math.round(v))}
            />
            <ReferenceLine y={100} strokeDasharray="4 4" className="stroke-muted-foreground" />
            <ChartTooltip
              contentStyle={{ fontSize: 12 }}
              formatter={(value, name) => {
                if (name === "band" && Array.isArray(value)) {
                  return [`${value[0]} – ${value[1]}`, "Likely range"];
                }
                return [value as number, "Price level"];
              }}
            />
            <Area
              dataKey="band"
              stroke="none"
              fill="#f59e0b"
              fillOpacity={0.15}
              isAnimationActive={false}
            />
            <Line
              dataKey="index"
              stroke="#f59e0b"
              strokeWidth={2}
              dot={{ r: 3 }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

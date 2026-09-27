import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
} from "recharts";

export function ItemVolumeOverTimeSection({
  volumeMode,
  setVolumeMode,
  volumeSeries,
}: {
  volumeMode: "price" | "unit";
  setVolumeMode: (mode: "price" | "unit") => void;
  volumeSeries: { label: string; gears: number; units: number }[];
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div>
            <h2 className="font-semibold">Volume over time</h2>
            <p className="text-xs text-muted-foreground">
              {volumeMode === "price" ? "Gears traded" : "Units sold"} per period, over the selected
              range (by in-game sale date).
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant={volumeMode === "price" ? "default" : "outline"}
              onClick={() => setVolumeMode("price")}
            >
              Gears
            </Button>
            <Button
              size="sm"
              variant={volumeMode === "unit" ? "default" : "outline"}
              onClick={() => setVolumeMode("unit")}
            >
              Units
            </Button>
          </div>
        </div>
        {volumeSeries.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No sales in this range.</p>
        ) : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={volumeSeries} margin={{ top: 4, right: 8, bottom: 18, left: 4 }}>
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10 }}
                  interval="preserveStartEnd"
                  minTickGap={16}
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  allowDecimals={false}
                  width={48}
                  tickFormatter={(v: number) =>
                    v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)
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
                  formatter={(value) => [
                    Number(value).toLocaleString(),
                    volumeMode === "price" ? "Gears traded" : "Units sold",
                  ]}
                />
                <Bar
                  dataKey={volumeMode === "price" ? "gears" : "units"}
                  fill="#6366f1"
                  name={volumeMode === "price" ? "Gears traded" : "Units sold"}
                  radius={[2, 2, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

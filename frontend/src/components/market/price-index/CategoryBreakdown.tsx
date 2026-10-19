import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { formatGears } from "@/lib/market/auction";
import type { PriceIndexCategory, PriceIndexCategoryPoint } from "@/models/auction";
import { cn } from "@/lib/helpers/utils";

export function MarketPriceIndexCategoryBreakdown({
  categories,
}: {
  categories: PriceIndexCategory[];
}) {
  const INITIAL = 15;
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const visible = showAll ? categories : categories.slice(0, INITIAL);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-1 font-medium">Which goods moved the most</div>
        <p className="mb-3 text-sm text-muted-foreground">
          Price change by type of item, from the start of tracking to now. Sorted by how much of the
          market they make up. The item count shows how many products back each figure — categories
          with only one or two are rougher estimates. Open a category to see its average price over
          time.
        </p>
        <ul className="divide-y divide-border text-sm">
          {visible.sortBy(["gearsTraded"], false).map((c) => {
            const open = expanded.has(c.category);
            return (
              <li key={c.category}>
                <button
                  type="button"
                  onClick={() => toggle(c.category)}
                  aria-expanded={open}
                  className="flex w-full items-center justify-between gap-3 py-1.5 text-left hover:bg-muted/50"
                >
                  <span className="flex items-center gap-1.5">
                    <ChevronRight open={open} />
                    <span className="capitalize">{c.category}</span>
                  </span>
                  <span className="flex items-center gap-3 tabular-nums">
                    <span className="text-xs text-muted-foreground min-w-14">
                      {c.salesCount?.toLocaleString() ?? " - "} sale{c.salesCount === 1 ? "" : "s"}
                    </span>
                    <span className="text-xs text-muted-foreground min-w-18">
                      {formatGears(c.gearsTraded)} traded
                    </span>
                    <span className="text-xs text-muted-foreground min-w-14">
                      {c.basketItems} item{c.basketItems === 1 ? "" : "s"}
                    </span>
                    <Pill pct={c.inflationPct} />
                  </span>
                </button>
                <div
                  className="grid transition-[grid-template-rows] duration-300 ease-out"
                  style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
                >
                  <div className="overflow-hidden">
                    <CategoryPriceChart points={c.priceTrend} />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        {categories.length > INITIAL && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="mt-3 text-sm text-primary hover:underline"
          >
            {showAll ? "Show fewer" : `Show all ${categories.length} categories`}
          </button>
        )}
      </CardContent>
    </Card>
  );
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function CategoryPriceChart({ points }: { points: PriceIndexCategoryPoint[] }) {
  const rows = (points ?? []).map((p) => ({
    date: shortDate(p.startUtc),
    index: p.index,
    basketItems: p.basketItems,
    sales: p.sales,
  }));
  const hasData = rows.length >= 2;

  return (
    <div className="pb-3 pt-1 pl-5">
      <div className="mb-2 text-xs text-muted-foreground">
        Price index (100 = category prices at the start of tracking)
      </div>
      {hasData ? (
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis
              tick={{ fontSize: 11 }}
              width={40}
              domain={["dataMin - 5", "dataMax + 5"]}
              tickFormatter={(v: number) => String(Math.round(v))}
            />
            <ReferenceLine y={100} strokeDasharray="4 4" className="stroke-muted-foreground" />
            <ChartTooltip
              contentStyle={{ fontSize: 12 }}
              labelClassName="text-foreground"
              formatter={(value, _name, item) => [
                `${(value as number).toFixed(1)} · ${item?.payload?.basketItems ?? 0} item${
                  item?.payload?.basketItems === 1 ? "" : "s"
                }`,
                "Price index",
              ]}
            />
            <Line
              dataKey="index"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={{ r: 2 }}
              connectNulls
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <p className="py-6 text-center text-xs text-muted-foreground">
          Not enough sales to chart a price trend for this category.
        </p>
      )}
    </div>
  );
}

function ChevronRight({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(
        "shrink-0 text-muted-foreground transition-transform duration-200",
        open && "rotate-90",
      )}
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function Pill({ pct }: { pct: number }) {
  const up = pct >= 0;
  return (
    <span
      className={cn(
        "min-w-20",
        up ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400",
      )}
    >
      {up ? "▲" : "▼"} {up ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  );
}

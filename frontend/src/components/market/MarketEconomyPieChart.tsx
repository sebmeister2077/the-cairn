// Economy-composition donut: how much each item — or each category — takes part
// in the Rusty Gears economy, within a selectable time window. To stay readable
// we only ever draw individual slices while they're meaningful: once at least
// `MIN_INDIVIDUAL_SLICES` slices are shown and the next one would contribute
// less than `SMALL_SLICE_PCT` of the total, every remaining entry is rolled into
// a single "Others" slice.
//
// The chart is self-contained: it carries its own time-window selector (shared
// with the rest of the market pages via `useMarketWindow`, so it stays in sync)
// and aggregates straight from the raw listings, so the window is always applied.
// "Group by" switches between per-item shares and per-category shares — the
// latter mirrors the Inflation page's category breakdown. When grouping by item
// a category filter narrows the pie to a single type of good.

import { useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as ChartTooltip } from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  INSIGHTS_WINDOWS,
  filterListingsByWindow,
  isSmartWindow,
  resolveWindowDays,
} from "@/hooks/useMarketInsights";
import { useMarketWindow } from "@/hooks/useMarketWindow";
import { formatGears } from "@/lib/auction";
import type { AuctionListing } from "@/models/auction";
import { capitalize } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";

/** Keep drawing individual slices until at least this many are shown… */
const MIN_INDIVIDUAL_SLICES = 12;
/** …after which entries contributing less than this share (%) fold into "Others". */
const SMALL_SLICE_PCT = 2;

const ALL_CATEGORIES = "__all__";
const OTHERS_KEY = "__others__";

type GroupBy = "item" | "category";

// Reasonably color-blind-friendly categorical palette (matches the usage charts).
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
const OTHERS_COLOR = "#94a3b8"; // slate-400

interface Entry {
  key: string;
  name: string;
  value: number;
}

interface Slice extends Entry {
  pct: number;
  /** How many entries this slice represents (1 for a real one, N for "Others"). */
  memberCount: number;
  color: string;
}

/**
 * Collapse aggregated entries into pie slices, grouping the long tail into a
 * single "Others" slice once the chart would otherwise get too noisy.
 */
function buildSlices(entries: Entry[], formatOthers: (count: number) => string): Slice[] {
  const sorted = entries.filter((e) => e.value > 0).sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, e) => sum + e.value, 0);
  if (total <= 0) return [];

  const individual: Slice[] = [];
  let othersValue = 0;
  let othersCount = 0;

  for (const e of sorted) {
    const pct = (e.value / total) * 100;
    // Once we have enough slices, a small contributor (and every smaller one
    // after it, since the list is sorted) goes into "Others".
    if (individual.length >= MIN_INDIVIDUAL_SLICES && pct < SMALL_SLICE_PCT) {
      othersValue += e.value;
      othersCount += 1;
    } else {
      individual.push({
        key: e.key,
        name: e.name,
        value: e.value,
        pct,
        memberCount: 1,
        color: PALETTE[individual.length % PALETTE.length],
      });
    }
  }

  if (othersValue > 0) {
    individual.push({
      key: OTHERS_KEY,
      name: formatOthers(othersCount),
      value: othersValue,
      pct: (othersValue / total) * 100,
      memberCount: othersCount,
      color: OTHERS_COLOR,
    });
  }

  return individual;
}

function SliceTooltip({ active, payload }: { active?: boolean; payload?: { payload: Slice }[] }) {
  if (!active || !payload?.length) return null;
  const s = payload[0].payload;
  return (
    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
      <div className="font-medium capitalize">{s.name}</div>
      <div className="tabular-nums text-muted-foreground">
        {formatGears(s.value)} · {s.pct.toFixed(1)}%
      </div>
    </div>
  );
}

export function MarketEconomyPieChart({
  listings,
  recordingStartGameHours,
}: {
  listings: AuctionListing[];
  recordingStartGameHours?: number | null;
}) {
  const [windowKey, setWindowKey] = useMarketWindow();
  const [groupBy, setGroupBy] = useState<GroupBy>("item");
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const { t } = useTranslation();

  // Sold, non-spam, non-barter listings carry the traded value (gears).
  const sold = useMemo(
    () => listings.filter((l) => l.sold && !l.spam && !l.externalTrade),
    [listings],
  );

  const windowed = useMemo(() => {
    const windowDays = resolveWindowDays(windowKey, recordingStartGameHours);
    // Window the full listing set (so the shared in-game reference clock matches
    // the rest of the page), then keep the sold/clean rows that carry value.
    return filterListingsByWindow(listings, windowDays, isSmartWindow(windowKey)).filter(
      (l) => l.sold && !l.spam && !l.externalTrade,
    );
  }, [listings, windowKey, recordingStartGameHours]);

  // Stable category list (from all sold listings) so the dropdown options don't
  // appear/disappear as the window changes.
  const categories = useMemo(() => Array.from(new Set(sold.map((l) => l.category))).sort(), [sold]);

  const slices = useMemo(() => {
    const byItem = groupBy === "item";
    const scoped =
      byItem && category !== ALL_CATEGORIES
        ? windowed.filter((l) => l.category === category)
        : windowed;

    const agg = new Map<string, Entry>();
    for (const l of scoped) {
      const key = byItem ? String(l.itemId) : l.category;
      const existing = agg.get(key);
      if (existing) existing.value += l.price;
      else agg.set(key, { key, name: byItem ? l.name : l.category, value: l.price });
    }
    return buildSlices(Array.from(agg.values()), (count) =>
      byItem
        ? t("marketEconomyPie.othersItems", { count })
        : t("marketEconomyPie.othersCategories", { count }),
    );
  }, [windowed, groupBy, category, t]);

  const total = useMemo(() => slices.reduce((sum, s) => sum + s.value, 0), [slices]);
  const windowLabel = INSIGHTS_WINDOWS.find((w) => w.key === windowKey)?.label ?? windowKey;

  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="font-medium">What makes up the economy</div>
            <p className="text-sm text-muted-foreground">
              Each {groupBy === "item" ? "item" : "category"}'s share of the Rusty Gears traded in
              the selected window. Small contributors are grouped into “Others” to keep the chart
              readable.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Group by */}
            <div className="flex items-center gap-1" role="group" aria-label="Group by">
              <Button
                size="sm"
                variant={groupBy === "item" ? "default" : "outline"}
                aria-pressed={groupBy === "item"}
                onClick={() => setGroupBy("item")}
              >
                In-Game Category
              </Button>
              <Button
                size="sm"
                variant={groupBy === "category" ? "default" : "outline"}
                aria-pressed={groupBy === "category"}
                onClick={() => setGroupBy("category")}
              >
                Cairn Category
              </Button>
            </div>

            {/* Category filter (only meaningful when grouping by item) */}
            {groupBy === "item" && (
              <Select value={category} onValueChange={(v) => setCategory(v ?? ALL_CATEGORIES)}>
                <SelectTrigger className="h-8 w-44 shrink-0" aria-label="Category">
                  <SelectValue>
                    {category === ALL_CATEGORIES ? "All categories" : capitalize(category)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c} value={c} className="capitalize">
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Time window */}
            {/* <Select
              value={windowKey}
              onValueChange={(v) => v && setWindowKey(v as typeof windowKey)}
            >
              <SelectTrigger className="h-8 w-40 shrink-0" aria-label="Time window">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INSIGHTS_WINDOWS.map((w) => (
                  <SelectItem key={w.key} value={w.key}>
                    {w.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select> */}
          </div>
        </div>

        {slices.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No sales recorded for this selection.
          </p>
        ) : (
          <div className="mt-2 flex flex-col items-center gap-4 sm:flex-row sm:items-center">
            <div className="h-64 w-full sm:w-1/2">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={slices}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="55%"
                    outerRadius="85%"
                    paddingAngle={1}
                    stroke="none"
                    isAnimationActive={false}
                  >
                    {slices.map((s) => (
                      <Cell key={s.key} fill={s.color} />
                    ))}
                  </Pie>
                  <ChartTooltip content={<SliceTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <ul className="w-full space-y-1.5 text-sm sm:w-1/2">
              {slices.map((s) => (
                <li key={s.key} className="flex items-center gap-2">
                  <span
                    className="size-3 shrink-0 rounded-sm"
                    style={{ backgroundColor: s.color }}
                    aria-hidden
                  />
                  <span className="truncate capitalize">{s.name}</span>
                  <span className="ml-auto shrink-0 tabular-nums font-medium">
                    {s.pct.toFixed(1)}%
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {formatGears(s.value)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {total > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Total traded over {windowLabel.toLowerCase()}
            {groupBy === "item" && category !== ALL_CATEGORIES ? ` in ${category}` : ""}:{" "}
            <span className="tabular-nums">{formatGears(total)}</span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

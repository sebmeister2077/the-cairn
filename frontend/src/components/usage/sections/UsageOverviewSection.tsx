import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminUsage, type UsageGranularity } from "@/lib/api";
import { ErrorMsg } from "@/components/usage/ErrorMsg";
import { Loading } from "@/components/usage/Loading";
import { TimeSeriesChart } from "@/components/usage/TimeSeriesChart";
import { useAppDispatch } from "@/store/hooks";
import { useAppSelector } from "@/store/hooks";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { toggleOverviewCategory, clearOverviewCategories } from "@/store/slices/adminUsageFilters";
import { StatCard } from "../StatCard";
import { TrendToggle } from "./UsageTrendToggle";
import { Button } from "@/components/ui/button";
import { HeatmapGrid } from "../HeatmapGrid";
import type { UsageSectionProps } from "@/pages/admin/AdminUsagePage";

// ---------------------------------------------------------------------------
// Section: Overview — headline counters, totals, category bars + heatmap.
// ---------------------------------------------------------------------------

export function OverviewSection(props: UsageSectionProps) {
  const [showTrend, setShowTrend] = useState(true);
  const dispatch = useAppDispatch();
  const selectedCategories = useAppSelector((s) => s.adminUsageFilters.overviewCategories);
  const summary = useQuery({
    queryKey: ["usage", "summary", props.from, props.to],
    queryFn: ({ signal }) => adminUsage.summary({ from: props.from, to: props.to }, signal),
  });
  const timeline = useQuery({
    queryKey: ["usage", "timeline", "category", props.from, props.to, props.granularity],
    queryFn: ({ signal }) =>
      adminUsage.timeline(
        { from: props.from, to: props.to, granularity: props.granularity, group_by: "category" },
        signal,
      ),
  });
  const heatmap = useQuery({
    queryKey: ["usage", "heatmap", props.from, props.to],
    queryFn: ({ signal }) => adminUsage.heatmap({ from: props.from, to: props.to }, signal),
  });

  // All categories ever seen in the current window. Derived from the
  // timeline so the chip set tracks the data; fall back to the summary's
  // per-category list before the timeline resolves.
  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    for (const b of timeline.data?.buckets ?? []) {
      if (b.series) set.add(String(b.series));
    }
    if (set.size === 0) {
      for (const c of summary.data?.per_category ?? []) set.add(c.category);
    }
    return Array.from(set).sort();
  }, [timeline.data, summary.data]);

  // Apply the Redux-backed filter. Empty selection = show everything.
  const filteredBuckets = useMemo(() => {
    if (!timeline.data) return [];
    if (selectedCategories.length === 0) return timeline.data.buckets;
    const allow = new Set(selectedCategories);
    return timeline.data.buckets.filter((b) => allow.has(String(b.series)));
  }, [timeline.data, selectedCategories]);

  if (summary.isLoading || timeline.isLoading || heatmap.isLoading) return <Loading />;
  if (summary.isError || !summary.data) return <ErrorMsg msg="Failed to load summary." />;

  const t = summary.data.totals;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Total events" value={t.events} previous={t.previous_events} />
        <StatCard label="Distinct actors" value={t.distinct_actors} />
        <StatCard
          label="Avg events / day"
          value={Math.round(t.events / Math.max(1, daysBetween(props.from, props.to)))}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 gap-4">
          <div className="space-y-1">
            <CardTitle>Events by category over time</CardTitle>
            <CardDescription>
              {selectedCategories.length === 0
                ? "Showing all categories. Click a chip to filter."
                : `Filtered: ${selectedCategories.join(", ")}`}
            </CardDescription>
          </div>
          <TrendToggle checked={showTrend} onChange={setShowTrend} id="overview-trend" />
        </CardHeader>
        <CardContent className="space-y-3">
          {availableCategories.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {availableCategories.map((cat) => {
                const active = selectedCategories.includes(cat);
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => dispatch(toggleOverviewCategory(cat))}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-foreground border-border hover:bg-accent"
                    }`}
                  >
                    {cat}
                  </button>
                );
              })}
              {selectedCategories.length > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => dispatch(clearOverviewCategories())}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          ) : null}
          <TimeSeriesChart
            data={filteredBuckets}
            xKey="bucket"
            yKey="count"
            seriesKey="series"
            stacked
            granularity={props.granularity}
            showTrend={showTrend}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Activity heatmap (UTC)</CardTitle>
        </CardHeader>
        <CardContent>
          {heatmap.data ? <HeatmapGrid cells={heatmap.data.cells} /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Per-category counts</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="text-sm divide-y">
            {summary.data.per_category.map((c) => (
              <li key={c.category} className="py-2 flex justify-between items-baseline">
                <span className="font-medium">{c.category}</span>
                <span className="tabular-nums">
                  {c.count.toLocaleString()}
                  <span className="ml-2 text-muted-foreground">
                    ({delta(c.count, c.previous_count)})
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
function daysBetween(fromIso: string, toIso: string): number {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)));
}

function delta(curr: number, prev: number): string {
  if (prev === 0) return curr > 0 ? "+∞" : "±0";
  const pct = ((curr - prev) / prev) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

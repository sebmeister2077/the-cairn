import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TimeSeriesChart } from "@/components/usage/TimeSeriesChart";
import { adminUsage, type UsageGranularity } from "@/lib/api";
import { ErrorMsg } from "../ErrorMsg";
import { Loading } from "../Loading";
import { StatCard } from "../StatCard";
import { formatDuration } from "@/lib/format-duration";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TrendToggle } from "./UsageTrendToggle";
import { Info } from "lucide-react";

// ---------------------------------------------------------------------------
// Section: Map Layers — TOPS map advanced-overlay usage.
// ---------------------------------------------------------------------------

const MAP_LAYER_LABELS: Record<string, string> = {
  oceans: "Oceans",
  broken_tls: "Broken translocators",
  rapids: "Rapids",
  trader_claims: "Trader claims",
  player_claims: "Player claims",
  rock_strata: "Rock strata",
  climate: "Climate",
  temporal_stability: "Temporal stability",
  auction_heatmap: "Auction heatmap",
};

function layerLabel(id: string): string {
  return MAP_LAYER_LABELS[id] ?? id;
}

export function MapLayersSection(props: {
  from: string;
  to: string;
  granularity: UsageGranularity;
}) {
  const [showTrend, setShowTrend] = useState(true);
  // "enables" counts switch-on events; "snapshots" counts how many daily
  // config snapshots had the layer on (reflects sustained, not just new, use).
  const [timelineMode, setTimelineMode] = useState<"enables" | "snapshots">("enables");
  const q = useQuery({
    queryKey: ["usage", "map-layers", props.from, props.to, props.granularity],
    queryFn: ({ signal }) =>
      adminUsage.mapLayers(
        { from: props.from, to: props.to, granularity: props.granularity, settings_limit: 60 },
        signal,
      ),
  });

  // Rank layers by how many daily snapshots had them on (the "most used"
  // signal), falling back to enable counts to break ties.
  const rankedLayers = useMemo(() => {
    const rows = [...(q.data?.layers ?? [])];
    rows.sort(
      (a, b) => b.snapshot_on_count - a.snapshot_on_count || b.enable_count - a.enable_count,
    );
    return rows;
  }, [q.data?.layers]);

  const timelineSeries = useMemo(() => {
    const source = timelineMode === "snapshots" ? q.data?.snapshot_timeline : q.data?.timeline;
    return (source ?? []).map((b) => ({
      bucket: b.bucket,
      series: layerLabel(b.series),
      count: b.count,
    }));
  }, [q.data?.timeline, q.data?.snapshot_timeline, timelineMode]);

  // Group the flat top-settings list by layer for a compact per-layer view.
  const settingsByLayer = useMemo(() => {
    const map = new Map<string, Array<{ setting: string; value: string; count: number }>>();
    for (const r of q.data?.top_settings ?? []) {
      const arr = map.get(r.layer) ?? [];
      arr.push({ setting: r.setting, value: r.value, count: r.count });
      map.set(r.layer, arr);
    }
    return map;
  }, [q.data?.top_settings]);

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorMsg msg="Failed to load map-layer analytics." />;

  const maxOn = rankedLayers.reduce((m, r) => Math.max(m, r.snapshot_on_count), 0) || 1;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <StatCard label="Daily snapshots" value={q.data.snapshot_total} />
        <StatCard
          label="Layers with usage"
          value={rankedLayers.filter((r) => r.enable_count > 0 || r.snapshot_on_count > 0).length}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 gap-4">
          <div className="space-y-1">
            <CardTitle>
              {timelineMode === "snapshots" ? "Layers on over time" : "Layer enables over time"}
            </CardTitle>
            <CardDescription>
              {timelineMode === "snapshots"
                ? `Daily snapshots that had each overlay on, per ${props.granularity}. Reflects sustained use — a layer left on keeps counting.`
                : `How often each advanced overlay was switched on, per ${props.granularity}. Counts new activations only.`}
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <Tabs
              value={timelineMode}
              onValueChange={(v) => setTimelineMode(v as "enables" | "snapshots")}
            >
              <TabsList>
                <TabsTrigger value="enables">Enables</TabsTrigger>
                <TabsTrigger value="snapshots">Layers on</TabsTrigger>
              </TabsList>
            </Tabs>
            <TrendToggle checked={showTrend} onChange={setShowTrend} id="map-layers-trend" />
          </div>
        </CardHeader>
        <CardContent>
          <TimeSeriesChart
            data={timelineSeries}
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
          <CardTitle>Most used advanced layers</CardTitle>
          <CardDescription>
            Ranked by how many daily config snapshots had the layer enabled. Hover a column heading
            for its exact meaning.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rankedLayers.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              No map-layer telemetry recorded in this window.
            </div>
          ) : (
            <TooltipProvider>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="py-2 pr-4 font-medium">Layer</th>
                    <MetricHeader
                      className="py-2 pr-4 font-medium tabular-nums text-right"
                      label="Users w/ on"
                      hint="Distinct signed-in accounts whose daily config snapshot had this layer switched on at least once in the window."
                    />
                    <MetricHeader
                      className="py-2 pr-4 font-medium tabular-nums text-right"
                      label="User-days on"
                      hint="Daily config snapshots (roughly one per active user per day) that had this layer on. This is the primary popularity measure and drives the ranking + share bar."
                    />
                    <MetricHeader
                      className="py-2 pr-4 font-medium tabular-nums text-right"
                      label="Enables"
                      hint="How many times the layer was switched on during the window. Each toggle-on counts once; leaving it on across days does not add to this."
                    />
                    <MetricHeader
                      className="py-2 pr-4 font-medium tabular-nums text-right"
                      label="Median dwell"
                      hint="Typical (50th-percentile) time the layer stayed on per viewing session — from switch-on until it was switched off or the map tab was hidden/closed. Median is used because a few very long sessions skew the mean. Time away from the page is not counted."
                    />
                    <MetricHeader
                      className="py-2 pr-4 font-medium tabular-nums text-right"
                      label="p90 dwell"
                      hint="90th-percentile session dwell: 9 in 10 sessions kept the layer on for less than this. Highlights the heavier-usage tail."
                    />
                    <th className="py-2 font-medium w-1/4">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {rankedLayers.map((row) => (
                    <tr key={row.layer} className="border-b">
                      <td className="py-2 pr-4">{layerLabel(row.layer)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {row.snapshot_on_actors.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {row.snapshot_on_count.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {row.enable_count.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {row.median_dwell_ms > 0 ? formatDuration(row.median_dwell_ms / 1000) : "—"}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {row.p90_dwell_ms > 0 ? formatDuration(row.p90_dwell_ms / 1000) : "—"}
                      </td>
                      <td className="py-2">
                        <div className="h-2 bg-muted rounded">
                          <div
                            className="h-2 bg-primary rounded"
                            style={{ width: `${(row.snapshot_on_count / maxOn) * 100}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TooltipProvider>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Popular settings</CardTitle>
          <CardDescription>
            Most common setting values chosen when each layer was enabled or adjusted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {settingsByLayer.size === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center">
              No setting data in this window.
            </div>
          ) : (
            rankedLayers
              .filter((r) => settingsByLayer.has(r.layer))
              .map((r) => (
                <div key={r.layer} className="space-y-1">
                  <div className="text-sm font-medium">{layerLabel(r.layer)}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(settingsByLayer.get(r.layer) ?? []).map((s, i) => (
                      <span
                        key={`${s.setting}-${s.value}-${i}`}
                        className="text-xs px-2 py-0.5 rounded-full border bg-background text-muted-foreground"
                      >
                        <span className="font-mono">{s.setting}</span>={s.value}{" "}
                        <span className="text-foreground">×{s.count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MetricHeader({
  label,
  hint,
  className,
}: {
  label: string;
  hint: string;
  className?: string;
}) {
  return (
    <th className={className}>
      <Tooltip>
        <TooltipTrigger className="inline-flex items-center gap-1 cursor-help underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">
          {label}
          <Info className="h-3 w-3 opacity-60" aria-hidden />
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
    </th>
  );
}

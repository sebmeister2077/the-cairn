import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DateRangeBar } from "@/components/usage/DateRangeBar";
import { GranularityToggle } from "@/components/usage/GranularityToggle";
import { StatCard } from "@/components/usage/StatCard";
import { TimeSeriesChart } from "@/components/usage/TimeSeriesChart";
import { adminRoutePlanner, type RoutePlannerEdgeRow, type UsageGranularity } from "@/lib/api";
import { MONTH_MS } from "@/lib/constants/time";
import { formatDuration } from "@/lib/format-duration";
import type { UsageSectionProps } from "@/pages/admin/AdminUsagePage";

const SETTING_LABELS: Record<string, string> = {
  walk_speed: "Walk speed",
  tl_penalty_seconds: "TL penalty (s)",
  k_neighbors: "Neighbours (k)",
  number_of_routes: "Alternatives",
  elk_friendly_only: "Elk-friendly only",
  rendezvous_objective: "Rendezvous objective",
  land_penalty: "Land penalty (sailboat)",
  tl_hop_cost: "TL hop cost (sailboat)",
  search_detail: "Search detail (sailboat)",
};

const SOURCE_LABELS: Record<string, string> = {
  "map-click": "Pick on map",
  landmark: "Landmark",
  paste: "Typed / pasted coords",
  favorite: "Home / favorite",
  url: "Shared link",
  unknown: "Unknown",
};

export function UsageRoutePlannerSection({ from, to, granularity }: UsageSectionProps) {
  const range = { from, to };

  const q = useQuery({
    queryKey: ["route-planner", range.from, range.to, granularity],
    queryFn: ({ signal }) =>
      adminRoutePlanner.bundle(
        { from: range.from, to: range.to, granularity, top_limit: 25, heatmap_cell: 128 },
        signal,
      ),
  });

  const timelineSeries = useMemo(() => {
    const rows: Array<{ bucket: string; series: string; count: number }> = [];
    for (const b of q.data?.timeline ?? []) {
      rows.push({
        bucket: b.bucket,
        series: "route",
        count: b.plans - b.rendezvous_plans - b.sailboat_plans,
      });
      rows.push({ bucket: b.bucket, series: "rendezvous", count: b.rendezvous_plans });
      rows.push({ bucket: b.bucket, series: "sailboat", count: b.sailboat_plans });
    }
    return rows;
  }, [q.data?.timeline]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Route planner</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          How people use the route &amp; rendezvous planner — completed computations, the settings
          they change, how they set coordinates, and which alternative they pick. Anonymous and
          aggregated. All times UTC.
        </p>
      </div>

      {q.isLoading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : q.isError || !q.data ? (
        <div className="py-6 text-center text-sm text-red-600">
          Failed to load route-planner analytics.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Completed plans"
              value={q.data.summary.total_plans.toLocaleString()}
              hint="Route + rendezvous + sailboat computations (24h soft-dedup per identity)."
            />
            <StatCard
              label="Route / rendezvous / sailboat"
              value={`${q.data.summary.route_plans.toLocaleString()} / ${q.data.summary.rendezvous_plans.toLocaleString()} / ${q.data.summary.sailboat_plans.toLocaleString()}`}
              hint="Split of completed plans by planner mode."
            />
            <StatCard
              label="Distinct identities"
              value={q.data.summary.distinct_identities.toLocaleString()}
              hint="Signed-in keys + hashed anon IPs."
            />
            <StatCard
              label="Segment zoom-ins"
              value={q.data.interaction_counts.segment_focused.toLocaleString()}
              hint='"Show this walk segment on the map" clicks.'
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Plans over time</CardTitle>
              <CardDescription>
                Completed route vs rendezvous vs sailboat computations per {granularity}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TimeSeriesChart
                data={timelineSeries}
                xKey="bucket"
                yKey="count"
                seriesKey="series"
                stacked
                granularity={granularity}
              />
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <SourceCard title="How the start was set" rows={q.data.source_breakdown.from} />
            <SourceCard title="How the destination was set" rows={q.data.source_breakdown.to} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Settings changed from defaults</CardTitle>
              <CardDescription>
                Of {q.data.settings_breakdown.total_plans.toLocaleString()} plans, how often each
                setting was changed away from its default (and the values chosen).
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Setting</th>
                    <th className="px-3 py-2 text-right">Changed in</th>
                    <th className="px-3 py-2">Popular values</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.settings_breakdown.settings.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-3 py-4 text-center text-muted-foreground">
                        Everyone used the defaults in this window.
                      </td>
                    </tr>
                  ) : (
                    q.data.settings_breakdown.settings.map((s) => (
                      <tr key={s.key} className="border-t align-top">
                        <td className="px-3 py-2">{SETTING_LABELS[s.key] ?? s.key}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {s.changed_plans.toLocaleString()}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1.5">
                            {s.values.slice(0, 8).map((v, i) => (
                              <span
                                key={i}
                                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                              >
                                {v.value ?? "—"} · {v.plans}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Which route people choose</CardTitle>
              <CardDescription>
                Rank of the alternative users picked (1 = best / fastest).{" "}
                {q.data.selected_rank_breakdown.total_plans > 0
                  ? `${Math.round(
                      (q.data.selected_rank_breakdown.overrode_best /
                        q.data.selected_rank_breakdown.total_plans) *
                        100,
                    )}% chose something other than the best route.`
                  : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Chosen route</th>
                    <th className="px-3 py-2 text-right">Plans</th>
                    <th className="px-3 py-2 text-right">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.selected_rank_breakdown.ranks.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-3 py-4 text-center text-muted-foreground">
                        No plans in this window.
                      </td>
                    </tr>
                  ) : (
                    q.data.selected_rank_breakdown.ranks.map((r) => {
                      const total = q.data!.selected_rank_breakdown.total_plans || 1;
                      return (
                        <tr key={r.rank} className="border-t">
                          <td className="px-3 py-2">
                            {r.rank === 0 ? "Best (1st)" : `#${r.rank + 1}`}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {r.plans.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {Math.round((r.plans / total) * 100)}%
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Most planned routes</CardTitle>
              <CardDescription>Endpoint pairs most often computed in this window.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Plans</th>
                    <th className="px-3 py-2">Mode</th>
                    <th className="px-3 py-2">From</th>
                    <th className="px-3 py-2">To</th>
                    <th className="px-3 py-2 text-right">Travel time</th>
                    <th className="px-3 py-2 text-right">TL hops</th>
                    <th className="px-3 py-2 text-right">Detour</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.top_routes.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-4 text-center text-muted-foreground">
                        No plans in this window.
                      </td>
                    </tr>
                  ) : (
                    q.data.top_routes.map((r, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-3 py-2 font-mono">{r.plans}</td>
                        <td className="px-3 py-2 text-xs">{r.mode}</td>
                        <td className="px-3 py-2">
                          <CoordCell label={r.from_label} x={r.from.x} z={r.from.z} />
                        </td>
                        <td className="px-3 py-2">
                          <CoordCell label={r.to_label} x={r.to.x} z={r.to.z} />
                        </td>
                        <td className="px-3 py-2 text-right">{formatDuration(r.total_seconds)}</td>
                        <td className="px-3 py-2 text-right">{r.tl_hops}</td>
                        <td className="px-3 py-2 text-right">
                          {r.detour_ratio != null ? r.detour_ratio.toFixed(2) + "×" : "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <EdgeTable
            title="Most used TL connections"
            description="Translocator pairs most often traversed in planned routes."
            rows={q.data.top_tl_edges}
          />

          <Card>
            <CardHeader>
              <CardTitle>Endpoint heatmap</CardTitle>
              <CardDescription>
                Coordinate cells (cell size {q.data.endpoint_heatmap.cell_blocks} blocks) with the
                most planning activity. See the map overlay on the TOPS map for a visual version.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <CellList title="Start cells" rows={q.data.endpoint_heatmap.from} />
              <CellList title="Destination cells" rows={q.data.endpoint_heatmap.to} />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function CoordCell(props: { label: string | null; x: number; z: number }) {
  return (
    <div className="flex flex-col leading-tight">
      {props.label ? <span className="truncate text-xs">{props.label}</span> : null}
      <span className="font-mono text-[11px] text-muted-foreground">
        ({props.x}, {props.z})
      </span>
    </div>
  );
}

function SourceCard(props: { title: string; rows: Array<{ source: string; plans: number }> }) {
  const total = props.rows.reduce((a, r) => a + r.plans, 0) || 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Method</th>
              <th className="px-3 py-2 text-right">Plans</th>
              <th className="px-3 py-2 text-right">Share</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-3 py-4 text-center text-muted-foreground">
                  No data in this window.
                </td>
              </tr>
            ) : (
              props.rows.map((r) => (
                <tr key={r.source} className="border-t">
                  <td className="px-3 py-2">{SOURCE_LABELS[r.source] ?? r.source}</td>
                  <td className="px-3 py-2 text-right font-mono">{r.plans.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right">{Math.round((r.plans / total) * 100)}%</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function EdgeTable(props: { title: string; description: string; rows: RoutePlannerEdgeRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Plans</th>
              <th className="px-3 py-2">From</th>
              <th className="px-3 py-2">To</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-3 py-4 text-center text-muted-foreground">
                  No data in this window.
                </td>
              </tr>
            ) : (
              props.rows.map((r) => (
                <tr key={r.edge} className="border-t">
                  <td className="px-3 py-2 font-mono">{r.plans}</td>
                  <td className="px-3 py-2 font-mono text-[11px]">
                    ({r.from.x}, {r.from.z})
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px]">
                    ({r.to.x}, {r.to.z})
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function CellList(props: { title: string; rows: Array<{ x: number; z: number; plans: number }> }) {
  const rows = [...props.rows].sort((a, b) => b.plans - a.plans).slice(0, 15);
  return (
    <div>
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.title}
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No data.</div>
      ) : (
        <ul className="space-y-1">
          {rows.map((r, i) => (
            <li key={i} className="flex items-center justify-between text-sm">
              <span className="font-mono text-[11px] text-muted-foreground">
                ({r.x}, {r.z})
              </span>
              <span className="font-mono">{r.plans.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

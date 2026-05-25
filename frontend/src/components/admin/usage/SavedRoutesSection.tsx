import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { adminUsage, type UsageGranularity } from "@/lib/api";
import { formatDuration } from "@/lib/format-duration";
import { StatCard } from "@/components/usage/StatCard";
import { TimeSeriesChart } from "@/components/usage/TimeSeriesChart";

/**
 * Admin dashboard section for the "Save this route for road workers"
 * analytics feed. Surfaces aggregations the road-work team uses to
 * prioritise tunnel work, signage, and shortcuts — without exposing
 * raw per-user data.
 *
 * Pulls everything via the single ``adminUsage.savedRoutes`` bundle
 * endpoint so adjusting the date range only fires one request.
 */
export function SavedRoutesSection(props: {
  from: string;
  to: string;
  granularity: UsageGranularity;
}) {
  const q = useQuery({
    queryKey: ["usage", "saved-routes", props.from, props.to, props.granularity],
    queryFn: ({ signal }) =>
      adminUsage.savedRoutes(
        {
          from: props.from,
          to: props.to,
          granularity: props.granularity,
          top_limit: 25,
          recent_limit: 50,
          heatmap_cell: 128,
        },
        signal,
      ),
  });

  // Reshape timeline to TimeSeriesChart's expected shape. The chart
  // wants `{ bucket, series, count }`; we have `{ bucket, saves,
  // distinct_routes }` so we synthesise two series.
  const timelineSeries = useMemo(() => {
    const rows: Array<{ bucket: string; series: string; count: number }> = [];
    for (const b of q.data?.timeline ?? []) {
      rows.push({ bucket: b.bucket, series: "saves", count: b.saves });
      rows.push({
        bucket: b.bucket,
        series: "distinct routes",
        count: b.distinct_routes,
      });
    }
    return rows;
  }, [q.data?.timeline]);

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="py-6 text-center text-sm text-red-600">
        Failed to load saved-route analytics.
      </div>
    );
  }

  const { summary, top_routes, top_tl_edges, top_start_hops, endpoint_heatmap, recent } = q.data;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total saves"
          value={summary.total_saves.toLocaleString()}
          hint="Each click of the road-workers button (24h soft-dedup)."
        />
        <StatCard
          label="Distinct routes"
          value={summary.distinct_routes.toLocaleString()}
          hint="Unique endpoint+TL-chain signatures."
        />
        <StatCard
          label="Distinct identities"
          value={summary.distinct_identities.toLocaleString()}
          hint="Signed-in keys + hashed anon IPs."
        />
        <StatCard
          label="Avg detour ratio"
          value={summary.avg_detour_ratio != null ? summary.avg_detour_ratio.toFixed(2) + "×" : "—"}
          hint="Walk blocks ÷ straight-line distance. >1 means the route detours."
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Saves over time</CardTitle>
          <CardDescription>
            Counts of save clicks and distinct routes per {props.granularity}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TimeSeriesChart
            data={timelineSeries}
            xKey="bucket"
            yKey="count"
            seriesKey="series"
            granularity={props.granularity}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Most popular routes</CardTitle>
          <CardDescription>
            Endpoint pairs most often saved. High detour ratios are the best candidates for a new
            tunnel or shortcut.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Saves</th>
                <th className="px-3 py-2">From</th>
                <th className="px-3 py-2">To</th>
                <th className="px-3 py-2 text-right">Travel time</th>
                <th className="px-3 py-2 text-right">Walk blocks</th>
                <th className="px-3 py-2 text-right">TL hops</th>
                <th className="px-3 py-2 text-right">Detour</th>
              </tr>
            </thead>
            <tbody>
              {top_routes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-muted-foreground">
                    No saves in this window.
                  </td>
                </tr>
              ) : (
                top_routes.map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-2 font-mono">{r.saves}</td>
                    <td className="px-3 py-2">
                      <CoordCell label={r.from_label} x={r.from.x} z={r.from.z} />
                    </td>
                    <td className="px-3 py-2">
                      <CoordCell label={r.to_label} x={r.to.x} z={r.to.z} />
                    </td>
                    <td className="px-3 py-2 text-right">{formatDuration(r.total_seconds)}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      {Math.round(r.walk_blocks).toLocaleString()}
                    </td>
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

      <div className="grid gap-4 lg:grid-cols-2">
        <EdgeTable
          title="Most popular TL connections"
          description="Translocator pairs most often used in saved routes."
          rows={top_tl_edges}
        />
        <EdgeTable
          title="Most popular first-hop TLs"
          description="The first translocator chosen from each saved route's starting point."
          rows={top_start_hops}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Endpoint heatmap</CardTitle>
          <CardDescription>
            Coordinate cells (cell size {endpoint_heatmap.cell_blocks} blocks) with the most save
            activity.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <CellList title="Start cells" rows={endpoint_heatmap.from} />
          <CellList title="Destination cells" rows={endpoint_heatmap.to} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent saves</CardTitle>
          <CardDescription>
            Latest {recent.length} save events (most recent first). IP hashes are truncated.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Identity</th>
                <th className="px-3 py-2">From</th>
                <th className="px-3 py-2">To</th>
                <th className="px-3 py-2 text-right">Time</th>
                <th className="px-3 py-2 text-right">Walk</th>
                <th className="px-3 py-2 text-right">TLs</th>
                <th className="px-3 py-2 text-right">Saves</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-4 text-center text-muted-foreground">
                    Nothing saved yet.
                  </td>
                </tr>
              ) : (
                recent.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {new Date(r.last_saved_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono">
                      {r.actor_api_key_id
                        ? r.actor_api_key_id.slice(0, 8) + "…"
                        : (r.ip_hash_short ?? "—")}
                    </td>
                    <td className="px-3 py-2">
                      <CoordCell label={r.from_label} x={r.from.x} z={r.from.z} />
                    </td>
                    <td className="px-3 py-2">
                      <CoordCell label={r.to_label} x={r.to.x} z={r.to.z} />
                    </td>
                    <td className="px-3 py-2 text-right">{formatDuration(r.total_seconds)}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      {Math.round(r.walk_blocks).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right">{r.tl_hops}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.save_count}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
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

function EdgeTable(props: {
  title: string;
  description: string;
  rows: Array<{
    edge: string;
    from: { x: number; z: number };
    to: { x: number; z: number };
    saves: number;
  }>;
}) {
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
              <th className="px-3 py-2">Saves</th>
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
                  <td className="px-3 py-2 font-mono">{r.saves}</td>
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

function CellList(props: { title: string; rows: Array<{ x: number; z: number; saves: number }> }) {
  const max = props.rows.reduce((m, r) => Math.max(m, r.saves), 0) || 1;
  return (
    <div>
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.title}
      </h4>
      {props.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No data.</p>
      ) : (
        <ul className="space-y-1">
          {props.rows.slice(0, 12).map((r, i) => (
            <li key={i} className="flex items-center gap-2 text-xs">
              <span className="w-24 font-mono text-muted-foreground">
                ({r.x}, {r.z})
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
                <div className="h-full bg-sky-500" style={{ width: `${(r.saves / max) * 100}%` }} />
              </div>
              <span className="w-10 text-right font-mono">{r.saves}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

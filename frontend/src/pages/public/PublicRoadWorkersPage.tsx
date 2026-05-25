import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { publicRoadWorkers } from "@/lib/api";
import { formatDuration } from "@/lib/format-duration";

/**
 * Always-public, unlisted page that surfaces the road-worker analytics
 * bundle so map maintainers (and curious players) can see which routes
 * the community wants improved.
 *
 * Intentionally bare: no auth, no API key, no admin chrome. The backend
 * IP-rate-limits and caches the response, and the page itself omits
 * recent-event data and length-clamps labels so it can't act as a
 * tracker.
 */
export function PublicRoadWorkersPage() {
  const [days, setDays] = useState(30);

  const q = useQuery({
    queryKey: ["public-road-workers", days],
    queryFn: ({ signal }) => publicRoadWorkers.get(days, signal),
    staleTime: 60_000,
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Road workers — saved routes</h1>
        <p className="text-sm text-muted-foreground">
          Aggregated, anonymous data from players who clicked{" "}
          <em>"Save this route for road workers"</em> in the route planner. Use it to prioritise
          tunnels, signage, and shortcuts. Personal data, IP addresses, and per-user activity are
          not shown.
        </p>
        <div className="flex items-center gap-2 pt-2">
          <label htmlFor="window-select" className="text-xs text-muted-foreground">
            Window:
          </label>
          <select
            id="window-select"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded border bg-background px-2 py-1 text-sm"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 180 days</option>
          </select>
        </div>
      </header>

      {q.isLoading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : q.isError || !q.data ? (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Could not load road-worker analytics. Please try again later.
        </div>
      ) : (
        <PublicContent data={q.data} />
      )}
    </div>
  );
}

function PublicContent({
  data,
}: {
  data: NonNullable<ReturnType<typeof publicRoadWorkers.get> extends Promise<infer T> ? T : never>;
}) {
  const { summary, top_routes, top_tl_edges, top_start_hops, endpoint_heatmap } = data;

  return (
    <>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KPI label="Total saves" value={summary.total_saves.toLocaleString()} />
        <KPI label="Distinct routes" value={summary.distinct_routes.toLocaleString()} />
        <KPI label="Distinct players" value={summary.distinct_identities.toLocaleString()} />
        <KPI
          label="Avg detour"
          value={summary.avg_detour_ratio != null ? summary.avg_detour_ratio.toFixed(2) + "×" : "—"}
          hint=">1× means players walked further than the straight line."
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Most popular saved routes</h2>
        <p className="text-xs text-muted-foreground">
          Endpoints (with optional labels) and travel time. High detour ratios are the strongest
          candidates for a new tunnel or shortcut.
        </p>
        <div className="overflow-x-auto rounded border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Saves</th>
                <th className="px-3 py-2">From</th>
                <th className="px-3 py-2">To</th>
                <th className="px-3 py-2 text-right">Time</th>
                <th className="px-3 py-2 text-right">Walk</th>
                <th className="px-3 py-2 text-right">TLs</th>
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
                      <Coord label={r.from_label} x={r.from.x} z={r.from.z} />
                    </td>
                    <td className="px-3 py-2">
                      <Coord label={r.to_label} x={r.to.x} z={r.to.z} />
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
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <EdgeBlock title="Most popular TL connections" rows={top_tl_edges} />
        <EdgeBlock title="Most popular first-hop TLs" rows={top_start_hops} />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Endpoint heatmap</h2>
        <p className="text-xs text-muted-foreground">
          Coordinate cells of {endpoint_heatmap.cell_blocks} blocks with the most save activity.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <Cells title="Start cells" rows={endpoint_heatmap.from} />
          <Cells title="Destination cells" rows={endpoint_heatmap.to} />
        </div>
      </section>
    </>
  );
}

function KPI(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border bg-card p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{props.label}</div>
      <div className="mt-1 text-2xl font-semibold">{props.value}</div>
      {props.hint && <div className="mt-1 text-[11px] text-muted-foreground">{props.hint}</div>}
    </div>
  );
}

function Coord(props: { label: string | null; x: number; z: number }) {
  return (
    <div className="flex flex-col leading-tight">
      {props.label && <span className="truncate text-xs">{props.label}</span>}
      <span className="font-mono text-[11px] text-muted-foreground">
        ({props.x}, {props.z})
      </span>
    </div>
  );
}

function EdgeBlock(props: {
  title: string;
  rows: Array<{
    edge: string;
    from: { x: number; z: number };
    to: { x: number; z: number };
    saves: number;
  }>;
}) {
  return (
    <div className="rounded border">
      <div className="border-b bg-muted/40 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.title}
      </div>
      <table className="w-full text-sm">
        <tbody>
          {props.rows.length === 0 ? (
            <tr>
              <td className="px-3 py-3 text-center text-muted-foreground">No data.</td>
            </tr>
          ) : (
            props.rows.map((r) => (
              <tr key={r.edge} className="border-t">
                <td className="px-3 py-2 font-mono">{r.saves}</td>
                <td className="px-3 py-2 font-mono text-[11px]">
                  ({r.from.x}, {r.from.z})
                </td>
                <td className="px-3 py-2 font-mono text-[11px]">
                  → ({r.to.x}, {r.to.z})
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Cells(props: { title: string; rows: Array<{ x: number; z: number; saves: number }> }) {
  const max = props.rows.reduce((m, r) => Math.max(m, r.saves), 0) || 1;
  return (
    <div className="rounded border p-3">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.title}
      </h3>
      {props.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No data.</p>
      ) : (
        <ul className="space-y-1">
          {props.rows.slice(0, 15).map((r, i) => (
            <li key={i} className="flex items-center gap-2 text-xs">
              <span className="w-28 font-mono text-muted-foreground">
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

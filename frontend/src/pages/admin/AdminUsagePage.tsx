import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { adminUsage, type UsageGranularity } from "@/lib/api";
import { Loader2 } from "lucide-react";
import { TimeSeriesChart } from "@/components/usage/TimeSeriesChart";
import { HeatmapGrid } from "@/components/usage/HeatmapGrid";
import { StatCard } from "@/components/usage/StatCard";
import { DateRangeBar } from "@/components/usage/DateRangeBar";
import { GranularityToggle } from "@/components/usage/GranularityToggle";

/**
 * Admin "Usage" dashboard.
 *
 * Read-only telemetry: drag a date range + granularity, see how the app
 * is being used. All sections share the same window/granularity state so
 * scrubbing recomputes every chart in lockstep.
 */
type SectionKey =
  | "overview"
  | "contributions"
  | "admin"
  | "queues"
  | "downloads"
  | "moderation"
  | "api_keys"
  | "actors";

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "contributions", label: "Contributions" },
  { key: "admin", label: "Admin Activity" },
  { key: "queues", label: "Queue Velocity" },
  { key: "downloads", label: "Downloads" },
  { key: "moderation", label: "Moderation" },
  { key: "api_keys", label: "API Keys" },
  { key: "actors", label: "Top Actors" },
];

function defaultWindow(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function AdminUsagePage() {
  const [section, setSection] = useState<SectionKey>("overview");
  const [range, setRange] = useState<{ from: string; to: string }>(defaultWindow);
  const [granularity, setGranularity] = useState<UsageGranularity>("day");

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="space-y-2">
          <CardTitle>Usage Analytics</CardTitle>
          <CardDescription>
            Patterns and waves of activity across the app. All times in UTC.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <DateRangeBar value={range} onChange={setRange} />
          <GranularityToggle value={granularity} onChange={setGranularity} />
        </CardContent>
      </Card>

      <Tabs value={section} onValueChange={(v) => setSection(v as SectionKey)}>
        <TabsList className="flex flex-wrap gap-1 h-auto">
          {SECTIONS.map((s) => (
            <TabsTrigger key={s.key} value={s.key}>
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {section === "overview" && (
        <OverviewSection from={range.from} to={range.to} granularity={granularity} />
      )}
      {section === "contributions" && (
        <ContributionsSection from={range.from} to={range.to} granularity={granularity} />
      )}
      {section === "admin" && (
        <AdminActivitySection from={range.from} to={range.to} granularity={granularity} />
      )}
      {section === "queues" && <QueueVelocitySection from={range.from} to={range.to} />}
      {section === "downloads" && (
        <DownloadsSection from={range.from} to={range.to} granularity={granularity} />
      )}
      {section === "moderation" && (
        <ModerationSection from={range.from} to={range.to} granularity={granularity} />
      )}
      {section === "api_keys" && (
        <ApiKeysSection from={range.from} to={range.to} granularity={granularity} />
      )}
      {section === "actors" && <TopActorsSection from={range.from} to={range.to} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section: Overview — headline counters, totals, category bars + heatmap.
// ---------------------------------------------------------------------------

function OverviewSection(props: { from: string; to: string; granularity: UsageGranularity }) {
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
        <CardHeader>
          <CardTitle>Events by category over time</CardTitle>
        </CardHeader>
        <CardContent>
          {timeline.data ? (
            <TimeSeriesChart
              data={timeline.data.buckets}
              xKey="bucket"
              yKey="count"
              seriesKey="series"
              stacked
              granularity={props.granularity}
            />
          ) : null}
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

// ---------------------------------------------------------------------------
// Section: Contributions — submitted / approved / per-type stacked bars.
// ---------------------------------------------------------------------------

function ContributionsSection(props: { from: string; to: string; granularity: UsageGranularity }) {
  const q = useQuery({
    queryKey: ["usage", "contributions", props.from, props.to, props.granularity],
    queryFn: ({ signal }) =>
      adminUsage.contributions(
        { from: props.from, to: props.to, granularity: props.granularity },
        signal,
      ),
  });

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorMsg msg="Failed to load contributions." />;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contribution activity</CardTitle>
        <CardDescription>
          User submissions vs. admin approvals/rejections per {props.granularity}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <TimeSeriesChart
          data={q.data.buckets}
          xKey="bucket"
          yKey="count"
          seriesKey="event_type"
          stacked
          granularity={props.granularity}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: Admin activity — bucketed counts + recent table.
// ---------------------------------------------------------------------------

function AdminActivitySection(props: { from: string; to: string; granularity: UsageGranularity }) {
  const q = useQuery({
    queryKey: ["usage", "admin", props.from, props.to, props.granularity],
    queryFn: ({ signal }) =>
      adminUsage.adminActivity(
        { from: props.from, to: props.to, granularity: props.granularity, limit_recent: 50 },
        signal,
      ),
  });

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorMsg msg="Failed to load admin activity." />;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Admin actions over time</CardTitle>
        </CardHeader>
        <CardContent>
          <TimeSeriesChart
            data={q.data.buckets}
            xKey="bucket"
            yKey="count"
            seriesKey="action"
            stacked
            granularity={props.granularity}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent admin actions</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground border-b">
              <tr>
                <th className="py-2 pr-4">When</th>
                <th className="py-2 pr-4">Action</th>
                <th className="py-2 pr-4">Admin</th>
                <th className="py-2 pr-4">Target / metadata</th>
              </tr>
            </thead>
            <tbody>
              {q.data.recent.map((r) => (
                <tr key={r.id} className="border-b last:border-b-0">
                  <td className="py-2 pr-4 whitespace-nowrap tabular-nums">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td className="py-2 pr-4 font-mono">{r.action}</td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {r.actor_api_key_id ? r.actor_api_key_id.slice(0, 8) : "—"}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs break-all">
                    {r.metadata ? JSON.stringify(r.metadata) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section: Queue velocity — review latency per queue.
// ---------------------------------------------------------------------------

function QueueVelocitySection(props: { from: string; to: string }) {
  const q = useQuery({
    queryKey: ["usage", "queue-velocity", props.from, props.to],
    queryFn: ({ signal }) => adminUsage.queueVelocity({ from: props.from, to: props.to }, signal),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorMsg msg="Failed to load queue stats." />;

  const rows: Array<
    [
      string,
      string,
      { median_seconds: number | null; p90_seconds: number | null; reviewed: number } | undefined,
      number,
    ]
  > = [
    [
      "map_contributions",
      "Map contributions",
      q.data.queues.map_contributions,
      q.data.backlog.map_contributions,
    ],
    [
      "landmark_edits",
      "Landmark edit requests",
      q.data.queues.landmark_edits,
      q.data.backlog.landmark_edits,
    ],
    [
      "tl_screenshots",
      "TL screenshot reviews",
      q.data.queues.tl_screenshots,
      q.data.backlog.tl_screenshots,
    ],
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review queue velocity</CardTitle>
        <CardDescription>How long items wait before a decision is made.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground border-b">
            <tr>
              <th className="py-2 pr-4">Queue</th>
              <th className="py-2 pr-4">Backlog</th>
              <th className="py-2 pr-4">Reviewed in window</th>
              <th className="py-2 pr-4">Median wait</th>
              <th className="py-2 pr-4">p90 wait</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, label, stats, backlog]) => (
              <tr key={key} className="border-b last:border-b-0">
                <td className="py-2 pr-4">{label}</td>
                <td className="py-2 pr-4 tabular-nums">{backlog.toLocaleString()}</td>
                <td className="py-2 pr-4 tabular-nums">{stats?.reviewed ?? 0}</td>
                <td className="py-2 pr-4 tabular-nums">{formatSeconds(stats?.median_seconds)}</td>
                <td className="py-2 pr-4 tabular-nums">{formatSeconds(stats?.p90_seconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: Downloads — backup link redemptions.
// ---------------------------------------------------------------------------

function DownloadsSection(props: { from: string; to: string; granularity: UsageGranularity }) {
  const q = useQuery({
    queryKey: ["usage", "downloads", props.from, props.to, props.granularity],
    queryFn: ({ signal }) =>
      adminUsage.downloads(
        { from: props.from, to: props.to, granularity: props.granularity, limit_recent: 50 },
        signal,
      ),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorMsg msg="Failed to load downloads." />;

  // Reshape: collapse `success` boolean into two series for stacked chart.
  const reshaped = q.data.buckets.map((b) => ({
    bucket: b.bucket,
    series: b.success ? "success" : "failed",
    count: b.count,
  }));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Backup link redemptions</CardTitle>
        </CardHeader>
        <CardContent>
          <TimeSeriesChart
            data={reshaped}
            xKey="bucket"
            yKey="count"
            seriesKey="series"
            stacked
            granularity={props.granularity}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent redemptions</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground border-b">
              <tr>
                <th className="py-2 pr-4">When</th>
                <th className="py-2 pr-4">Link</th>
                <th className="py-2 pr-4">IP (hash prefix)</th>
                <th className="py-2 pr-4">UA</th>
                <th className="py-2 pr-4">Result</th>
              </tr>
            </thead>
            <tbody>
              {q.data.recent.map((r) => (
                <tr key={r.id} className="border-b last:border-b-0">
                  <td className="py-2 pr-4 whitespace-nowrap tabular-nums">
                    {r.redeemed_at ? new Date(r.redeemed_at).toLocaleString() : "—"}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">#{r.link_id}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{r.ip_hash || "—"}</td>
                  <td className="py-2 pr-4 text-xs truncate" title={r.user_agent ?? ""}>
                    {r.user_agent || "—"}
                  </td>
                  <td className="py-2 pr-4">{r.success ? "ok" : r.failure_reason || "failed"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section: Moderation — bans created, flags created/resolved.
// ---------------------------------------------------------------------------

function ModerationSection(props: { from: string; to: string; granularity: UsageGranularity }) {
  const q = useQuery({
    queryKey: ["usage", "moderation", props.from, props.to, props.granularity],
    queryFn: ({ signal }) =>
      adminUsage.moderation(
        { from: props.from, to: props.to, granularity: props.granularity },
        signal,
      ),
  });
  // Hooks first — must run unconditionally on every render. The early
  // returns below would otherwise change hook order between renders
  // ("rendered more hooks than during the previous render").
  const merged = useMemo(() => {
    if (!q.data) return [];
    const out: Array<{ bucket: string; series: string; count: number }> = [];
    for (const r of q.data.bans_created)
      out.push({ bucket: r.bucket, series: "bans", count: r.count });
    for (const r of q.data.flags_created)
      out.push({ bucket: r.bucket, series: "flags_created", count: r.count });
    for (const r of q.data.flags_resolved)
      out.push({ bucket: r.bucket, series: "flags_resolved", count: r.count });
    return out;
  }, [q.data]);

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorMsg msg="Failed to load moderation stats." />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Moderation activity</CardTitle>
      </CardHeader>
      <CardContent>
        <TimeSeriesChart
          data={merged}
          xKey="bucket"
          yKey="count"
          seriesKey="series"
          granularity={props.granularity}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: API keys — new vs active.
// ---------------------------------------------------------------------------

function ApiKeysSection(props: { from: string; to: string; granularity: UsageGranularity }) {
  const q = useQuery({
    queryKey: ["usage", "api-keys", props.from, props.to, props.granularity],
    queryFn: ({ signal }) =>
      adminUsage.apiKeys(
        { from: props.from, to: props.to, granularity: props.granularity },
        signal,
      ),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorMsg msg="Failed to load api-key stats." />;

  const merged = [
    ...q.data.new_keys.map((r) => ({ bucket: r.bucket, series: "new", count: r.count })),
    ...q.data.active_keys.map((r) => ({ bucket: r.bucket, series: "active", count: r.count })),
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>New keys created vs. distinct active keys per bucket.</CardDescription>
      </CardHeader>
      <CardContent>
        <TimeSeriesChart
          data={merged}
          xKey="bucket"
          yKey="count"
          seriesKey="series"
          granularity={props.granularity}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: Top actors.
// ---------------------------------------------------------------------------

function TopActorsSection(props: { from: string; to: string }) {
  const [category, setCategory] = useState<string>("");
  const q = useQuery({
    queryKey: ["usage", "top-actors", props.from, props.to, category],
    queryFn: ({ signal }) =>
      adminUsage.topActors(
        { from: props.from, to: props.to, category: category || undefined, limit: 20 },
        signal,
      ),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top actors</CardTitle>
        <CardDescription>Most active API keys in the selected window.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2 mb-3">
          {["", "contribution", "admin", "download", "moderation"].map((c) => (
            <Button
              key={c || "all"}
              size="sm"
              variant={category === c ? "default" : "outline"}
              onClick={() => setCategory(c)}
            >
              {c || "all"}
            </Button>
          ))}
        </div>
        {q.isLoading ? (
          <Loading />
        ) : q.isError || !q.data ? (
          <ErrorMsg msg="Failed to load top actors." />
        ) : (
          <ul className="text-sm divide-y">
            {q.data.actors.map((a) => (
              <li key={a.actor_api_key_id} className="py-2 flex justify-between items-baseline">
                <span className="font-medium">
                  {a.display_name ?? (
                    <span className="font-mono text-xs">{a.actor_api_key_id.slice(0, 8)}</span>
                  )}
                </span>
                <span className="tabular-nums">{a.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Loading() {
  return (
    <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </div>
  );
}

function ErrorMsg({ msg }: { msg: string }) {
  return <div className="text-sm text-red-600 py-6 text-center">{msg}</div>;
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

function formatSeconds(s: number | null | undefined): string {
  if (s == null) return "—";
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

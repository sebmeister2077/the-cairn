import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { adminUsage, type UsageGranularity } from "@/lib/api";
import { Loader2 } from "lucide-react";
import { TimeSeriesChart } from "@/components/usage/TimeSeriesChart";
import { HeatmapGrid } from "@/components/usage/HeatmapGrid";
import { StatCard } from "@/components/usage/StatCard";
import { DateRangeBar } from "@/components/usage/DateRangeBar";
import { GranularityToggle } from "@/components/usage/GranularityToggle";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  clearOverviewCategories,
  patchPagesFilters,
  resetPagesFilters,
  setPagesSelectedPath,
  toggleOverviewCategory,
  type PagesSortKey,
} from "@/store/slices/adminUsageFilters";
import { Input } from "@/components/ui/input";

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
  | "pages"
  | "admin"
  | "queues"
  | "downloads"
  | "moderation"
  | "api_keys"
  | "actors";

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "contributions", label: "Contributions" },
  { key: "pages", label: "Pages" },
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
      {section === "pages" && (
        <PagesSection from={range.from} to={range.to} granularity={granularity} />
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

// ---------------------------------------------------------------------------
// Section: Contributions — submitted / approved / per-type stacked bars.
// ---------------------------------------------------------------------------

function ContributionsSection(props: { from: string; to: string; granularity: UsageGranularity }) {
  const [showTrend, setShowTrend] = useState(true);
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
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle>Contribution activity</CardTitle>
          <CardDescription>
            User submissions vs. admin approvals/rejections per {props.granularity}.
          </CardDescription>
        </div>
        <TrendToggle checked={showTrend} onChange={setShowTrend} id="contrib-trend" />
      </CardHeader>
      <CardContent>
        <TimeSeriesChart
          data={q.data.buckets}
          xKey="bucket"
          yKey="count"
          seriesKey="event_type"
          stacked
          granularity={props.granularity}
          showTrend={showTrend}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: Pages — most-visited routes table + per-path trendline.
// ---------------------------------------------------------------------------

function PagesSection(props: { from: string; to: string; granularity: UsageGranularity }) {
  const [showTrend, setShowTrend] = useState(true);
  const dispatch = useAppDispatch();
  const filters = useAppSelector((s) => s.adminUsageFilters.pages);
  const { query, minViews, sortKey, sortOrder, selectedPath } = filters;

  const q = useQuery({
    queryKey: ["usage", "pages", props.from, props.to, props.granularity, selectedPath ?? ""],
    queryFn: ({ signal }) =>
      adminUsage.pages(
        {
          from: props.from,
          to: props.to,
          granularity: props.granularity,
          limit: 20,
          path: selectedPath ?? undefined,
        },
        signal,
      ),
  });

  // Client-side filter + sort over the top-N response. Cheap (≤20 rows)
  // and keeps the backend cache hot since the request shape doesn't
  // depend on these knobs.
  const visibleRows = useMemo(() => {
    const top = q.data?.top ?? [];
    const needle = query.trim().toLowerCase();
    const rows = top.filter((r) => {
      if (r.views < minViews) return false;
      if (needle && !r.path.toLowerCase().includes(needle)) return false;
      return true;
    });
    rows.sort((a, b) => {
      const dir = sortOrder === "asc" ? 1 : -1;
      if (sortKey === "path") return a.path.localeCompare(b.path) * dir;
      return (a[sortKey] - b[sortKey]) * dir;
    });
    return rows;
  }, [q.data, query, minViews, sortKey, sortOrder]);

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorMsg msg="Failed to load page analytics." />;

  const maxViews = visibleRows.reduce((m, r) => Math.max(m, r.views), 0) || 1;
  const hasActiveFilter =
    query.trim() !== "" || minViews > 0 || sortKey !== "views" || sortOrder !== "desc";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 gap-4">
          <div className="space-y-1">
            <CardTitle>
              {selectedPath ? `Views: ${selectedPath}` : "Top 5 routes over time"}
            </CardTitle>
            <CardDescription>
              {selectedPath
                ? "Showing traffic for the selected route only."
                : `Stacked traffic for the top 5 routes per ${props.granularity}.`}
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            {selectedPath ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => dispatch(setPagesSelectedPath(null))}
              >
                Clear drill-down
              </Button>
            ) : null}
            <TrendToggle checked={showTrend} onChange={setShowTrend} id="pages-trend" />
          </div>
        </CardHeader>
        <CardContent>
          <TimeSeriesChart
            data={q.data.timeline}
            xKey="bucket"
            yKey="count"
            seriesKey="path"
            stacked
            granularity={props.granularity}
            showTrend={showTrend}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Most visited pages</CardTitle>
          <CardDescription>
            Click a row to drill into a single route. Distinct actors = signed-in API keys; distinct
            IPs = unique hashed visitor IPs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1 min-w-55 flex-1">
              <Label htmlFor="pages-search" className="text-xs text-muted-foreground">
                Search path
              </Label>
              <Input
                id="pages-search"
                value={query}
                placeholder="/blog, /multiplayer/…"
                onChange={(e) => dispatch(patchPagesFilters({ query: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1 w-28">
              <Label htmlFor="pages-min-views" className="text-xs text-muted-foreground">
                Min views
              </Label>
              <Input
                id="pages-min-views"
                type="number"
                min={0}
                value={minViews || ""}
                placeholder="0"
                onChange={(e) =>
                  dispatch(
                    patchPagesFilters({
                      minViews: Math.max(0, Number(e.target.value) || 0),
                    }),
                  )
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="pages-sort" className="text-xs text-muted-foreground">
                Sort by
              </Label>
              <select
                id="pages-sort"
                value={sortKey}
                onChange={(e) =>
                  dispatch(patchPagesFilters({ sortKey: e.target.value as PagesSortKey }))
                }
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="views">Views</option>
                <option value="distinct_actors">Distinct actors</option>
                <option value="distinct_ips">Distinct IPs</option>
                <option value="path">Path (A→Z)</option>
              </select>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                dispatch(patchPagesFilters({ sortOrder: sortOrder === "asc" ? "desc" : "asc" }))
              }
            >
              {sortOrder === "asc" ? "Ascending ↑" : "Descending ↓"}
            </Button>
            {hasActiveFilter ? (
              <Button size="sm" variant="ghost" onClick={() => dispatch(resetPagesFilters())}>
                Reset filters
              </Button>
            ) : null}
          </div>

          {visibleRows.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              {q.data.top.length === 0
                ? "No page-view events recorded in this window."
                : "No rows match the current filters."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="py-2 pr-4 font-medium">Path</th>
                    <th className="py-2 pr-4 font-medium tabular-nums text-right">Views</th>
                    <th className="py-2 pr-4 font-medium tabular-nums text-right">Actors</th>
                    <th className="py-2 pr-4 font-medium tabular-nums text-right">IPs</th>
                    <th className="py-2 font-medium w-1/3">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => {
                    const isActive = row.path === selectedPath;
                    return (
                      <tr
                        key={row.path}
                        onClick={() => dispatch(setPagesSelectedPath(isActive ? null : row.path))}
                        className={`border-b cursor-pointer hover:bg-accent/40 ${
                          isActive ? "bg-accent/60" : ""
                        }`}
                      >
                        <td className="py-2 pr-4 font-mono text-xs">{row.path}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {row.views.toLocaleString()}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {row.distinct_actors.toLocaleString()}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {row.distinct_ips.toLocaleString()}
                        </td>
                        <td className="py-2">
                          <div className="h-2 bg-muted rounded">
                            <div
                              className="h-2 bg-primary rounded"
                              style={{ width: `${(row.views / maxViews) * 100}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
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

function TrendToggle({
  checked,
  onChange,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  id: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} size="sm" />
      <Label htmlFor={id} className="text-xs text-muted-foreground cursor-pointer">
        Trend line
      </Label>
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

function formatSeconds(s: number | null | undefined): string {
  if (s == null) return "—";
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

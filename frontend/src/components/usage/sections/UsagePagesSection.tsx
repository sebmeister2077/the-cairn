import { adminUsage, type UsageGranularity } from "@/lib/api";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  setPagesSelectedPath,
  patchPagesFilters,
  type PagesSortKey,
  resetPagesFilters,
} from "@/store/slices/adminUsageFilters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectItem } from "@/components/ui/select";
import { SelectContent } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { ErrorMsg } from "../ErrorMsg";
import { Loading } from "../Loading";
import { TimeSeriesChart } from "../TimeSeriesChart";
import { TrendToggle } from "./UsageTrendToggle";
import type { UsageSectionProps } from "@/pages/admin/AdminUsagePage";

// ---------------------------------------------------------------------------
// Section: Pages — most-visited routes table + per-path trendline.
// ---------------------------------------------------------------------------

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "views", label: "Views" },
  { value: "distinct_actors", label: "Distinct actors" },
  { value: "distinct_ips", label: "Distinct IPs" },
  { value: "path", label: "Path (A→Z)" },
];
export function PagesSection(props: UsageSectionProps) {
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
              <Select
                id="pages-sort"
                value={sortKey}
                onValueChange={(v) => dispatch(patchPagesFilters({ sortKey: v as PagesSortKey }))}
              >
                <SelectTrigger className="h-9 rounded-md border bg-background px-2 text-sm">
                  <SelectValue>
                    {(value) =>
                      SORT_OPTIONS.find((s) => s.value === value)?.label || "Select a sort"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {SORT_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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

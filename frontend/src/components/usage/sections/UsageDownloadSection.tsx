import { adminUsage } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { ErrorMsg } from "@/components/usage/ErrorMsg";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { UsageGranularity } from "@/lib/api";
import { TimeSeriesChart } from "@/components/usage/TimeSeriesChart";
import { Loading } from "@/components/usage/Loading";
import type { UsageSectionProps } from "@/pages/admin/AdminUsagePage";

// ---------------------------------------------------------------------------
// Section: Downloads — backup link redemptions.
// ---------------------------------------------------------------------------

export function DownloadsSection(props: UsageSectionProps) {
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

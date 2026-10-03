import { useQuery } from "@tanstack/react-query";
import { adminUsage } from "@/lib/api";
import { Loading } from "@/components/usage/Loading";
import { ErrorMsg } from "@/components/usage/ErrorMsg";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { TimeSeriesChart } from "@/components/usage/TimeSeriesChart";
import type { UsageGranularity } from "@/lib/api";

// ---------------------------------------------------------------------------
// Section: Admin activity — bucketed counts + recent table.
// ---------------------------------------------------------------------------

export function AdminActivitySection(props: {
  from: string;
  to: string;
  granularity: UsageGranularity;
}) {
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

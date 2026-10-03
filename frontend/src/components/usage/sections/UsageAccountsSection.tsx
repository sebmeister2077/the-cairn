import { adminUsage } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { ErrorMsg } from "@/components/usage/ErrorMsg";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import type { UsageGranularity } from "@/lib/api";
import { TimeSeriesChart } from "@/components/usage/TimeSeriesChart";
import { Loading } from "@/components/usage/Loading";

// ---------------------------------------------------------------------------
// Section: Accounts — new vs active.
// ---------------------------------------------------------------------------

export function AccountsSection(props: {
  from: string;
  to: string;
  granularity: UsageGranularity;
}) {
  // Accounts with zero lifetime activity are always excluded here.
  const q = useQuery({
    queryKey: ["usage", "api-keys", props.from, props.to, props.granularity],
    queryFn: ({ signal }) =>
      adminUsage.apiKeys(
        {
          from: props.from,
          to: props.to,
          granularity: props.granularity,
          exclude_unused: true,
        },
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
      <CardHeader className="space-y-1.5">
        <CardTitle>Accounts</CardTitle>
        <CardDescription>
          New accounts created vs. accounts that made at least one request, per bucket. Accounts
          that never made a request are excluded.
        </CardDescription>
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

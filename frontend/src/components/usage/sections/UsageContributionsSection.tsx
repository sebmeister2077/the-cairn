import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminUsage, type UsageGranularity } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Loading } from "@/components/usage/Loading";
import { ErrorMsg } from "@/components/usage/ErrorMsg";
import { TrendToggle } from "@/components/usage/sections/UsageTrendToggle";
import { TimeSeriesChart } from "@/components/usage/TimeSeriesChart";

// ---------------------------------------------------------------------------
// Section: Contributions — submitted / approved / per-type stacked bars.
// ---------------------------------------------------------------------------

export function ContributionsSection(props: {
  from: string;
  to: string;
  granularity: UsageGranularity;
}) {
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

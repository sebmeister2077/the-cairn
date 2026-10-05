import { adminUsage } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { ErrorMsg } from "@/components/usage/ErrorMsg";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { UsageGranularity } from "@/lib/api";
import { TimeSeriesChart } from "@/components/usage/TimeSeriesChart";
import { Loading } from "@/components/usage/Loading";
import { useMemo } from "react";
import type { UsageSectionProps } from "@/pages/admin/AdminUsagePage";

// ---------------------------------------------------------------------------
// Section: Moderation — bans created, flags created/resolved.
// ---------------------------------------------------------------------------

export function ModerationSection(props: UsageSectionProps) {
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

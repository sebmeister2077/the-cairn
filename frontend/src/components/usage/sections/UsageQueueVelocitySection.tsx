import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { formatSeconds } from "@/lib/utils";
import { adminUsage } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { ErrorMsg } from "../ErrorMsg";
import { Loading } from "../Loading";
import type { UsageSectionProps } from "@/pages/admin/AdminUsagePage";

// ---------------------------------------------------------------------------
// Section: Queue velocity — review latency per queue.
// ---------------------------------------------------------------------------

export function QueueVelocitySection(props: UsageSectionProps) {
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

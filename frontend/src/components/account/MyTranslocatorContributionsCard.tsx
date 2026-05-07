/**
 * Account self-history card listing the caller's own translocator
 * contributions (most recent first). Powered by
 * ``GET /api/account/contribute-tls`` — server returns rows from the
 * translocators_audit table with action='add'.
 */

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { getMyTranslocatorContributions } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTimestamp } from "@/lib/utils";

export function MyTranslocatorContributionsCard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["my-translocator-contributions"],
    queryFn: getMyTranslocatorContributions,
    retry: false,
  });

  // Hide the card entirely when the user has nothing to show — keeps the
  // account page tidy for users who never used the contribute flow.
  if (!isLoading && !error && (!data || data.contributions.length === 0)) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">My contributed translocators</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && (
          <div className="flex justify-center py-4">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {data && data.contributions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="text-left border-b">
                  <th className="py-1.5 pr-3 font-medium">Submitted</th>
                  <th className="py-1.5 pr-3 font-medium">Coordinates</th>
                  <th className="py-1.5 pr-3 font-medium">Label</th>
                </tr>
              </thead>
              <tbody>
                {data.contributions.map((row) => {
                  const coords = row.coordinates;
                  const a = Array.isArray(coords) ? coords[0] : null;
                  const b = Array.isArray(coords) ? coords[1] : null;
                  // Server stores +Z = south; display as +Z = north.
                  const fmt = (p: number[] | null | undefined) =>
                    p && p.length >= 2
                      ? `(${Math.round(p[0]).toLocaleString()}, ${Math.round(-p[1]).toLocaleString()})`
                      : "—";
                  return (
                    <tr key={row.segment_id} className="border-b last:border-b-0">
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        {formatTimestamp(row.created_at)}
                      </td>
                      <td className="py-1.5 pr-3 font-mono whitespace-nowrap">
                        {fmt(a)} &rarr; {fmt(b)}
                      </td>
                      <td className="py-1.5 pr-3">{row.label || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

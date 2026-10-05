import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminUsage } from "@/lib/api";
import { ErrorMsg } from "@/components/usage/ErrorMsg";
import { Loading } from "@/components/usage/Loading";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { UsageSectionProps } from "@/pages/admin/AdminUsagePage";

// ---------------------------------------------------------------------------
// Section: Top actors.
// ---------------------------------------------------------------------------

export function TopActorsSection(props: UsageSectionProps) {
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

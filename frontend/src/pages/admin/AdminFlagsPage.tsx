import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { adminListFlags, adminResolveFlag } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";

export function AdminFlagsPage() {
  const queryClient = useQueryClient();
  const [unresolvedOnly, setUnresolvedOnly] = useState(true);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-flags", unresolvedOnly],
    queryFn: () => adminListFlags({ unresolved_only: unresolvedOnly }),
  });

  const resolveMut = useMutation({
    mutationFn: ({ id, resolution }: { id: number; resolution: "valid" | "abuse" | "dismissed" }) =>
      adminResolveFlag(id, resolution),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-flags"] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold">User Flags</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Reports raised by users or auto-detected by the system.
          </p>
        </div>
        <label className="flex items-center gap-1 text-sm">
          <Checkbox
            checked={unresolvedOnly}
            onCheckedChange={(checked) => setUnresolvedOnly(checked === true)}
          />
          Unresolved only
        </label>
      </div>

      {isLoading && (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {data && data.flags.length === 0 && (
        <p className="text-sm text-muted-foreground py-4 text-center">No flags.</p>
      )}

      <div className="space-y-2">
        {data?.flags.map((f) => (
          <Card key={f.id}>
            <CardContent className="py-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge>{f.reason}</Badge>
                <span className="text-xs text-muted-foreground">
                  {new Date(f.created_at).toLocaleString()}
                </span>
                {f.resolved_at && <Badge variant="outline">Resolved: {f.resolution}</Badge>}
              </div>
              <div className="text-sm">
                <span className="font-mono">
                  {f.flagged_display_name ?? f.flagged_user.slice(0, 8)}
                </span>
                {f.related_display_name && (
                  <>
                    {" "}
                    ⟷ <span className="font-mono">{f.related_display_name}</span>
                  </>
                )}
              </div>
              {f.metadata && (
                <pre className="text-[10px] bg-muted rounded p-2 overflow-x-auto">
                  {JSON.stringify(f.metadata, null, 2)}
                </pre>
              )}
              {!f.resolved_at && (
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => resolveMut.mutate({ id: f.id, resolution: "abuse" })}
                  >
                    Mark as abuse
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resolveMut.mutate({ id: f.id, resolution: "valid" })}
                  >
                    Valid
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resolveMut.mutate({ id: f.id, resolution: "dismissed" })}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

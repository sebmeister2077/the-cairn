import type { ContributeInfo } from "@/models/contributions";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Undo2 } from "lucide-react";

export function WithdrawnContributionsCard({
  info,
  isAdmin,
}: {
  info: ContributeInfo | null;
  isAdmin: boolean;
}) {
  if (!info || (!isAdmin && !info.is_admin) || !info.withdrawn || info.withdrawn.length === 0)
    return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-muted-foreground">
          <Undo2 className="h-4 w-4" />
          Withdrawn Contributions
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {info.withdrawn
            .slice()
            .sortBy(["withdrawn_at"], false)
            .map((w) => (
              <div
                key={w.id}
                className="flex items-center justify-between text-sm border-b last:border-0 pb-2 last:pb-0 opacity-60"
              >
                <div>
                  <span className="font-medium text-muted-foreground">[Withdrawn]</span>
                  <span className="text-xs text-muted-foreground ml-2 font-mono">{w.id}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(w.withdrawn_at).toLocaleDateString()}
                </span>
              </div>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}

import { Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import type { ContributeInfo } from "@/pages/ContributePage";

type Props = {
  info: ContributeInfo | null;
};
export function ContributionsCard({ info }: Props) {
  if (!info) return null;
  const revertedIds = new Set(
    (info.history ?? [])
      .filter((h) => h.status === "reverted" || h.status === "orphaned_by_restore")
      .map((h) => h.id),
  );
  const visibleApproved = info.approved.filter((a) => !revertedIds.has(a.id));
  if (visibleApproved.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="h-4 w-4" />
          Approved Contributions
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {visibleApproved
            .slice()
            .sort((a, b) => new Date(b.approved_at).getTime() - new Date(a.approved_at).getTime())
            .map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between text-sm border-b last:border-0 pb-2 last:pb-0"
              >
                <div>
                  <span className="font-medium">{a.contributor}</span>
                  <span className="text-muted-foreground ml-2">
                    +{a.tiles_new.toLocaleString()} new chunks
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(a.approved_at).toLocaleDateString()}
                </span>
              </div>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}

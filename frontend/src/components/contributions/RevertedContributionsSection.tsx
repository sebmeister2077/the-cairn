import type { ContributeInfo } from "@/models/contributions";
import { useTranslation } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Undo2 } from "lucide-react";

export function RevertedContributionsSection({
  info,
  isAdmin,
}: {
  info: ContributeInfo | null;
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  if (
    !info ||
    (!isAdmin && !info.is_admin) ||
    !info.history ||
    !info.history.some((h) => h.status === "reverted" || h.status === "orphaned_by_restore")
  ) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-muted-foreground">
          <Undo2 className="h-4 w-4" />
          {t("contributePage.reverted.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {info.history
            .filter((h) => h.status === "reverted" || h.status === "orphaned_by_restore")
            .sortBy(["reverted_at", "approved_at"], false)
            .map((h) => (
              <div
                key={h.id}
                className="flex items-center justify-between text-sm border-b last:border-0 pb-2 last:pb-0 opacity-60"
              >
                <div>
                  <span className="font-medium">{h.contributor}</span>
                  <span className="text-muted-foreground ml-2">
                    {h.status === "orphaned_by_restore"
                      ? t("contributePage.reverted.orphanedByRestore")
                      : t("contributePage.reverted.reverted")}
                  </span>
                  <span className="text-xs text-muted-foreground ml-2 font-mono">{h.id}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {h.reverted_at
                    ? new Date(h.reverted_at).toLocaleDateString()
                    : h.approved_at
                      ? new Date(h.approved_at).toLocaleDateString()
                      : t("contributePage.reverted.unknownDate")}
                </span>
              </div>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}

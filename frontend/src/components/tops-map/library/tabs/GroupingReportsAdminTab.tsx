import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useTranslation } from "@/lib/i18n";
import { useAdminGroupingReports } from "@/hooks/useGroupingLibrary";

import { Centered, EmptyState } from "../libraryShared";

export function GroupingReportsAdminTab() {
  const { t } = useTranslation();
  const { reports, isLoading, remove, resolveReport } = useAdminGroupingReports();

  if (isLoading) {
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  }
  if (reports.length === 0) {
    return <EmptyState text={t("topsMap.groupingsDrawer.library.noReports")} />;
  }
  return (
    <ul className="flex flex-col gap-2">
      {reports.map((report) => (
        <li key={report.id} className="rounded-md border p-2.5">
          <p className="font-medium">
            {t("topsMap.groupingsDrawer.library.reportedItem", {
              name: report.grouping_name ?? report.grouping_id,
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {report.reason}
            {report.reporter ? ` · ${report.reporter}` : ""}
          </p>
          {report.details && (
            <p className="mt-1 text-xs italic text-muted-foreground">{report.details}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void resolveReport(report.id, false)}
            >
              {t("topsMap.groupingsDrawer.library.resolve")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void resolveReport(report.id, true)}>
              {t("topsMap.groupingsDrawer.library.dismiss")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => void remove(report.grouping_id)}
            >
              <Trash2 className="size-3.5 mr-1" />
              {t("topsMap.groupingsDrawer.library.adminRemove")}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

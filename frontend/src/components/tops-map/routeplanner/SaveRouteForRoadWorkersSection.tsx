import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { Loader2, Check, Send } from "lucide-react";

export function SaveRouteForRoadWorkersSection({
  analyticsState,
  analyticsError,
  handleSaveForRoadWorkers,
}: {
  analyticsState: "idle" | "sending" | "sent" | "error";
  analyticsError: string | null;
  handleSaveForRoadWorkers: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1 rounded-md border border-sky-200 bg-sky-50 p-2 dark:border-sky-900/50 dark:bg-sky-950/40">
      <p className="text-[11px] leading-snug text-sky-900 dark:text-sky-100">
        {t("routePlanner.analyticsInfo")}
      </p>
      <Button
        size="sm"
        variant="default"
        className="w-full gap-1.5"
        onClick={handleSaveForRoadWorkers}
        disabled={analyticsState === "sending" || analyticsState === "sent"}
      >
        {analyticsState === "sending" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : analyticsState === "sent" ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Send className="h-3.5 w-3.5" />
        )}
        {analyticsState === "sending"
          ? t("routePlanner.analyticsSending")
          : analyticsState === "sent"
            ? t("routePlanner.analyticsSent")
            : t("routePlanner.analyticsSave")}
      </Button>
      {analyticsState === "error" && analyticsError && (
        <p className="px-1 text-[11px] text-red-600 dark:text-red-400">{analyticsError}</p>
      )}
    </div>
  );
}

import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import type { RouteResult } from "@/lib/tl-routing";
import { BookmarkPlus, Check, Share2 } from "lucide-react";

export function RouteDraftTLGroupingSection({
  primary,
  handleSaveAsDraft,
  handleCopyShareLink,
  canShare,
  shareCopied,
  savedDraft,
}: {
  primary: RouteResult;
  handleSaveAsDraft: () => void;
  handleCopyShareLink: () => void;
  canShare: boolean;
  shareCopied: boolean;
  savedDraft: { name: string; id: string } | null;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          className="flex-1 gap-1.5"
          onClick={handleSaveAsDraft}
          disabled={primary.tlHops === 0}
          title={
            primary.tlHops === 0
              ? t("routePlanner.saveDraftNoTls")
              : t("routePlanner.saveDraftTitle")
          }
        >
          <BookmarkPlus className="h-3.5 w-3.5" />
          {t("routePlanner.saveDraftButton")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1 gap-1.5"
          onClick={handleCopyShareLink}
          disabled={!canShare}
          title={
            canShare ? t("routePlanner.shareRouteTitle") : t("routePlanner.shareNothingToShare")
          }
        >
          {shareCopied ? (
            <>
              <Check className="h-3.5 w-3.5" />
              {t("routePlanner.copiedShareLink")}
            </>
          ) : (
            <>
              <Share2 className="h-3.5 w-3.5" />
              {t("routePlanner.shareRoute")}
            </>
          )}
        </Button>
      </div>
      {savedDraft && (
        <p className="flex items-center gap-1 px-1 text-[11px] text-emerald-700 dark:text-emerald-400">
          <Check className="h-3 w-3" />
          {t("routePlanner.savedAs", { name: savedDraft.name })}
        </p>
      )}
    </div>
  );
}

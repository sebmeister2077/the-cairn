import { Check, History, RefreshCw, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type LibrarySubscription } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";

interface SubscribedGroupingItemProps {
  sub: LibrarySubscription;
  onSync: () => void | Promise<void>;
  onUnsubscribe: () => void | Promise<void>;
  onHistory: () => void;
}

export function SubscribedGroupingItem({
  sub,
  onSync,
  onUnsubscribe,
  onHistory,
}: SubscribedGroupingItemProps) {
  const { t } = useTranslation();
  const isDeprecated = sub.status === "deprecated";
  return (
    <li className="rounded-md border p-2.5">
      <div className="flex items-center gap-2">
        {sub.color && (
          <span
            className="size-3 shrink-0 rounded-full border"
            style={{ backgroundColor: sub.color }}
          />
        )}
        <span className="truncate font-medium">{sub.name}</span>
        {isDeprecated && (
          <Badge variant="outline" className="gap-1 border-amber-500/60 text-amber-600">
            <TriangleAlert className="size-3" />
            {t("topsMap.groupingsDrawer.library.deprecated")}
          </Badge>
        )}
        {!isDeprecated && sub.has_update && (
          <Badge variant="default" className="gap-1">
            <TriangleAlert className="size-3" />
            {t("topsMap.groupingsDrawer.library.updateAvailable", {
              version: sub.head_version,
            })}
          </Badge>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {t("topsMap.groupingsDrawer.library.by", {
          name: sub.author ?? t("topsMap.groupingsDrawer.library.anonymous"),
        })}
        {" · "}
        {t("topsMap.groupingsDrawer.library.tls", { count: sub.tlIds.length })}
      </p>
      {isDeprecated && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("topsMap.groupingsDrawer.library.deprecatedHint")}
          {sub.successor_id ? (
            <>
              {" — "}
              {t("topsMap.groupingsDrawer.library.successorAvailable")}
            </>
          ) : null}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {!isDeprecated && sub.has_update ? (
          <Button size="sm" onClick={() => void onSync()}>
            <RefreshCw className="size-3.5 mr-1" />
            {t("topsMap.groupingsDrawer.library.syncNow")}
          </Button>
        ) : !isDeprecated ? (
          <Badge variant="secondary" className="gap-1">
            <Check className="size-3" />
            {t("topsMap.groupingsDrawer.library.synced")}
          </Badge>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onHistory}
          title={t("topsMap.groupingsDrawer.library.viewHistory")}
        >
          <History className="size-4" />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void onUnsubscribe()}>
          {t("topsMap.groupingsDrawer.library.unsubscribe")}
        </Button>
      </div>
    </li>
  );
}

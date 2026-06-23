import { useState } from "react";
import { History, Trash2, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { type LibraryGroupingCard } from "@/lib/api";
import { Trans, useTranslation } from "@/lib/i18n";

import { GroupingCardHeader } from "./GroupingCardHeader";

interface MyPublishedGroupingCardProps {
  card: LibraryGroupingCard;
  onEdit: () => void;
  onUnpublish: () => void | Promise<void>;
  onHistory: () => void;
}

export function MyPublishedGroupingCard({
  card,
  onEdit,
  onUnpublish,
  onHistory,
}: MyPublishedGroupingCardProps) {
  const { t } = useTranslation();
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const isDeprecated = card.status === "deprecated";
  return (
    <li className="rounded-md border p-2.5">
      <GroupingCardHeader card={card} />
      {isDeprecated && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <Badge variant="outline" className="gap-1 border-amber-500/60 text-amber-600">
            <TriangleAlert className="size-3" />
            {t("topsMap.groupingsDrawer.library.deprecated")}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {t("topsMap.groupingsDrawer.library.deprecatedHint")}
          </span>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" onClick={onEdit} disabled={isDeprecated}>
          {t("topsMap.groupingsDrawer.library.publishUpdate")}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onHistory}
          title={t("topsMap.groupingsDrawer.library.viewHistory")}
        >
          <History className="size-4" />
        </Button>
        {!isDeprecated && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            onClick={() => setConfirmUnpublish(true)}
          >
            <Trash2 className="size-3.5 mr-1" />
            {t("topsMap.groupingsDrawer.library.unpublish")}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirmUnpublish}
        title={t("topsMap.groupingsDrawer.library.unpublishTitle")}
        description={
          <Trans
            path="topsMap.groupingsDrawer.library.unpublishDescription"
            values={{ name: card.name }}
            components={{ strong: <strong /> }}
          />
        }
        confirmLabel={t("topsMap.groupingsDrawer.library.unpublish")}
        cancelLabel={t("topsMap.groupingsDrawer.cancel")}
        variant="destructive"
        onConfirm={() => {
          void onUnpublish();
          setConfirmUnpublish(false);
        }}
        onCancel={() => setConfirmUnpublish(false)}
      />
    </li>
  );
}

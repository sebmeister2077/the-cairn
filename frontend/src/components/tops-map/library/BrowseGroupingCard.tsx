import { useState } from "react";
import {
  BadgeCheck,
  Check,
  Download,
  Flag,
  GitFork,
  History,
  ThumbsUp,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { type LibraryGroupingCard } from "@/lib/api";
import { Trans, useTranslation } from "@/lib/i18n";

import { GroupingCardHeader } from "./GroupingCardHeader";
import { ReportGroupingDialog } from "./ReportGroupingDialog";

export interface BrowseGroupingCardAdminActions {
  adminSetOfficial: (id: string, official: boolean) => Promise<unknown>;
  adminRemove: (id: string, reason?: string) => Promise<unknown>;
}

interface BrowseGroupingCardProps {
  card: LibraryGroupingCard;
  isAdmin: boolean;
  onFork: () => void | Promise<void>;
  onSubscribe: () => void | Promise<void>;
  onUnsubscribe: () => void | Promise<void>;
  onUpvote: () => void | Promise<void>;
  onReport: (reason: string, details?: string) => void | Promise<void>;
  onHistory: () => void;
  adminActions?: BrowseGroupingCardAdminActions;
}

export function BrowseGroupingCard({
  card,
  isAdmin,
  onFork,
  onSubscribe,
  onUnsubscribe,
  onUpvote,
  onReport,
  onHistory,
  adminActions,
}: BrowseGroupingCardProps) {
  const { t } = useTranslation();
  const [reporting, setReporting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const subscribed = card.viewer_install?.mode === "subscribe";

  return (
    <li className="rounded-md border p-2.5">
      <div className="flex items-start gap-2">
        <GroupingCardHeader card={card} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" onClick={() => void onFork()}>
          <GitFork className="size-3.5 mr-1" />
          {t("topsMap.groupingsDrawer.library.fork")}
        </Button>
        {subscribed ? (
          <Button size="sm" variant="secondary" onClick={() => void onUnsubscribe()}>
            <Check className="size-3.5 mr-1" />
            {t("topsMap.groupingsDrawer.library.subscribed")}
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => void onSubscribe()}>
            <Download className="size-3.5 mr-1" />
            {t("topsMap.groupingsDrawer.library.subscribe")}
          </Button>
        )}
        <Button
          size="sm"
          variant={card.viewer_voted ? "default" : "ghost"}
          onClick={() => void onUpvote()}
          title={
            card.viewer_voted
              ? t("topsMap.groupingsDrawer.library.removeUpvote")
              : t("topsMap.groupingsDrawer.library.upvote")
          }
        >
          <ThumbsUp className="size-3.5 mr-1" />
          {card.upvote_count}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onHistory}
          title={t("topsMap.groupingsDrawer.library.viewHistory")}
        >
          <History className="size-4" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => setReporting(true)}
          title={t("topsMap.groupingsDrawer.library.report")}
        >
          <Flag className="size-4" />
        </Button>
        {isAdmin && adminActions && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void adminActions.adminSetOfficial(card.id, !card.is_official)}
            >
              <BadgeCheck className="size-3.5 mr-1" />
              {card.is_official
                ? t("topsMap.groupingsDrawer.library.unmarkOfficial")
                : t("topsMap.groupingsDrawer.library.markOfficial")}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => setRemoving(true)}
              title={t("topsMap.groupingsDrawer.library.adminRemove")}
            >
              <Trash2 className="size-4" />
            </Button>
          </>
        )}
      </div>

      <ReportGroupingDialog
        open={reporting}
        onOpenChange={setReporting}
        groupingName={card.name}
        onSubmit={onReport}
      />

      {adminActions && (
        <ConfirmDialog
          open={removing}
          title={t("topsMap.groupingsDrawer.library.adminRemoveTitle")}
          description={
            <Trans
              path="topsMap.groupingsDrawer.library.adminRemoveDescription"
              values={{ name: card.name }}
              components={{ strong: <strong /> }}
            />
          }
          confirmLabel={t("topsMap.groupingsDrawer.library.adminRemove")}
          cancelLabel={t("topsMap.groupingsDrawer.cancel")}
          variant="destructive"
          onConfirm={() => {
            void adminActions.adminRemove(card.id);
            setRemoving(false);
          }}
          onCancel={() => setRemoving(false)}
        />
      )}
    </li>
  );
}

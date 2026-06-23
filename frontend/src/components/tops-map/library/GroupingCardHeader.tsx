import { BadgeCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { type LibraryGroupingCard } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";

import { ReputationBadge } from "./ReputationBadge";

export function GroupingCardHeader({ card }: { card: LibraryGroupingCard }) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        {card.color && (
          <span
            className="size-3 shrink-0 rounded-full border"
            style={{ backgroundColor: card.color }}
          />
        )}
        <span className="truncate font-medium">{card.name}</span>
        {card.is_official && (
          <Badge variant="default" className="gap-1">
            <BadgeCheck className="size-3" />
            {t("topsMap.groupingsDrawer.library.official")}
          </Badge>
        )}
      </div>
      {card.description && (
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{card.description}</p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          {t("topsMap.groupingsDrawer.library.by", {
            name: card.author ?? t("topsMap.groupingsDrawer.library.anonymous"),
          })}
        </span>
        <ReputationBadge score={card.author_reputation} />
        <span>{t("topsMap.groupingsDrawer.library.tls", { count: card.tl_count })}</span>
        <span>·</span>
        <span>{t("topsMap.groupingsDrawer.library.installs", { count: card.install_count })}</span>
        <span>·</span>
        <span>{t("topsMap.groupingsDrawer.library.upvotes", { count: card.upvote_count })}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {card.created_at && (
          <span>
            {t("topsMap.groupingsDrawer.library.publishedOn", {
              date: new Date(card.created_at).toLocaleDateString(),
            })}
          </span>
        )}
        {card.last_edited_at && card.last_edited_at !== card.created_at && (
          <>
            <span>·</span>
            <span>
              {t("topsMap.groupingsDrawer.library.updatedOn", {
                date: new Date(card.last_edited_at).toLocaleDateString(),
              })}
            </span>
          </>
        )}
      </div>
      {card.tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {card.tags.map((tag) => (
            <Badge key={tag} variant="outline" className="text-[10px]">
              {tag}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

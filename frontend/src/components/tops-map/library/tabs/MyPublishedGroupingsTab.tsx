import { useState } from "react";

import { Spinner } from "@/components/ui/spinner";
import { type LibraryGroupingCard, type LibraryVersionSnapshot } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import type { UseTLGroupingsResult } from "@/lib/tl-groupings";
import { useGroupingLibraryActions, useMyGroupings } from "@/hooks/useGroupingLibrary";

import { GroupingHistoryDialog } from "../GroupingHistoryDialog";
import { MyPublishedGroupingCard } from "../MyPublishedGroupingCard";
import { PublishGroupingDialog } from "../PublishGroupingDialog";
import { Centered, EmptyState } from "../libraryShared";

interface MyPublishedGroupingsTabProps {
  store: UseTLGroupingsResult;
  active: boolean;
}

export function MyPublishedGroupingsTab({ store, active }: MyPublishedGroupingsTabProps) {
  const { t } = useTranslation();
  const mine = useMyGroupings(active);
  const actions = useGroupingLibraryActions();

  const [historyId, setHistoryId] = useState<string | null>(null);
  const [historyName, setHistoryName] = useState<string | undefined>();
  const [editCard, setEditCard] = useState<LibraryGroupingCard | null>(null);

  function forkSnapshot(libraryId: string, name: string, snapshot: LibraryVersionSnapshot) {
    store.installLibraryGrouping({
      libraryId,
      name: snapshot.name || name,
      color: snapshot.color,
      tlIds: snapshot.tlIds,
      version: snapshot.version,
      mode: "fork",
    });
  }

  return (
    <>
      {mine.isLoading ? (
        <Centered>
          <Spinner />
        </Centered>
      ) : !mine.data || mine.data.length === 0 ? (
        <EmptyState text={t("topsMap.groupingsDrawer.library.empty")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {mine.data.map((card) => (
            <MyPublishedGroupingCard
              key={card.id}
              card={card}
              onEdit={() => setEditCard(card)}
              onUnpublish={async () => {
                await actions.unpublish(card.id);
                // Drop the local -> library-id link on any local grouping
                // that pointed at this row. Otherwise the publish dialog
                // still treats it as an "edit" and PATCHes a deprecated row
                // (404 "Grouping not found"), leaving the user unable to
                // re-publish.
                for (const g of store.groupings) {
                  if (g.publishedId === card.id) {
                    store.markPublished(g.id, undefined);
                  }
                }
              }}
              onHistory={() => {
                setHistoryId(card.id);
                setHistoryName(card.name);
              }}
            />
          ))}
        </ul>
      )}

      <GroupingHistoryDialog
        open={historyId !== null}
        onOpenChange={(v) => !v && setHistoryId(null)}
        groupingId={historyId}
        groupingName={historyName}
        onForkVersion={(snapshot) => {
          if (historyId) forkSnapshot(historyId, historyName ?? "", snapshot);
          setHistoryId(null);
        }}
      />

      <PublishGroupingDialog
        open={editCard !== null}
        onOpenChange={(v) => !v && setEditCard(null)}
        grouping={
          editCard
            ? {
                id: editCard.id,
                name: editCard.name,
                color: editCard.color ?? undefined,
                tlIds: editCard.tlIds ?? [],
                createdAt: 0,
                updatedAt: 0,
              }
            : null
        }
        editLibraryId={editCard?.id}
        onPublished={() => {
          setEditCard(null);
          void actions.invalidateAll();
        }}
      />
    </>
  );
}

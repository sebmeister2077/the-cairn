import { useState } from "react";

import { Spinner } from "@/components/ui/spinner";
import { type LibrarySubscription, type LibraryVersionSnapshot } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import type { UseTLGroupingsResult } from "@/lib/tl-groupings";
import { useGroupingLibraryActions, useGroupingSubscriptions } from "@/hooks/useGroupingLibrary";

import { GroupingHistoryDialog } from "../GroupingHistoryDialog";
import { SubscribedGroupingItem } from "../SubscribedGroupingItem";
import { Centered, EmptyState } from "../libraryShared";

interface SubscribedGroupingsTabProps {
  store: UseTLGroupingsResult;
  active: boolean;
}

export function SubscribedGroupingsTab({ store, active }: SubscribedGroupingsTabProps) {
  const { t } = useTranslation();
  const subscriptions = useGroupingSubscriptions(active);
  const actions = useGroupingLibraryActions();

  const [historyId, setHistoryId] = useState<string | null>(null);
  const [historyName, setHistoryName] = useState<string | undefined>();

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

  async function handleSync(sub: LibrarySubscription) {
    // Re-installing in subscribe mode bumps synced_version to head and
    // returns the current head payload we mirror into the local copy.
    const result = await actions.install(sub.id, "subscribe");
    store.syncSubscribedGrouping(sub.id, {
      name: result.grouping.name,
      color: result.grouping.color,
      tlIds: result.grouping.tlIds,
      version: result.grouping.version,
      author: result.grouping.author,
    });
  }

  return (
    <>
      {subscriptions.isLoading ? (
        <Centered>
          <Spinner />
        </Centered>
      ) : !subscriptions.data || subscriptions.data.length === 0 ? (
        <EmptyState text={t("topsMap.groupingsDrawer.library.empty")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {subscriptions.data.map((sub) => (
            <SubscribedGroupingItem
              key={sub.id}
              sub={sub}
              onSync={() => handleSync(sub)}
              onUnsubscribe={async () => {
                await actions.uninstall(sub.id);
              }}
              onHistory={() => {
                setHistoryId(sub.id);
                setHistoryName(sub.name);
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
    </>
  );
}

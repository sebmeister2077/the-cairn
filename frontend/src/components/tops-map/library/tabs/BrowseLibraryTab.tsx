import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  type GroupingLibrarySort,
  type LibraryGroupingCard,
  type LibraryVersionSnapshot,
} from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import type { UseTLGroupingsResult } from "@/lib/tl-groupings";
import { useGroupingLibraryActions, useGroupingLibraryBrowse } from "@/hooks/useGroupingLibrary";

import { BrowseGroupingCard } from "../BrowseGroupingCard";
import { GroupingHistoryDialog } from "../GroupingHistoryDialog";
import { Centered, EmptyState, toInstallPayload } from "../libraryShared";

const SORTS: GroupingLibrarySort[] = ["popular", "installs", "recent", "official"];

interface BrowseLibraryTabProps {
  store: UseTLGroupingsResult;
  isAdmin: boolean;
  /** Whether the parent dialog is open — gates query enable. */
  active: boolean;
}

export function BrowseLibraryTab({ store, isAdmin, active }: BrowseLibraryTabProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<GroupingLibrarySort>("popular");
  const [officialOnly, setOfficialOnly] = useState(false);

  const params = useMemo(
    () => ({ q: search.trim() || undefined, sort, officialOnly, pageSize: 30 }),
    [search, sort, officialOnly],
  );
  const browse = useGroupingLibraryBrowse(params, active);
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

  async function handleFork(card: LibraryGroupingCard) {
    const result = await actions.install(card.id, "fork");
    store.installLibraryGrouping(toInstallPayload(result));
  }

  async function handleSubscribe(card: LibraryGroupingCard) {
    const result = await actions.install(card.id, "subscribe");
    store.installLibraryGrouping(toInstallPayload(result));
  }

  const total = browse.data?.total;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Input
          value={search}
          placeholder={t("topsMap.groupingsDrawer.library.searchPlaceholder")}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border">
            {SORTS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSort(s)}
                className={`px-2 py-1 text-xs transition-colors cursor-pointer ${
                  sort === s ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
              >
                {t(`topsMap.groupingsDrawer.library.sort.${s}` as const)}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <Checkbox checked={officialOnly} onCheckedChange={(v) => setOfficialOnly(Boolean(v))} />
            {t("topsMap.groupingsDrawer.library.officialOnly")}
          </label>
          {typeof total === "number" && !browse.featureDisabled && (
            <span className="ml-auto text-xs text-muted-foreground">
              {t("topsMap.groupingsDrawer.library.totalCount", { count: total })}
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {browse.featureDisabled ? (
          <EmptyState
            icon={<AlertTriangle className="size-5" />}
            text={t("topsMap.groupingsDrawer.library.disabled")}
          />
        ) : browse.isLoading ? (
          <Centered>
            <Spinner />
          </Centered>
        ) : !browse.data || browse.data.items.length === 0 ? (
          <EmptyState text={t("topsMap.groupingsDrawer.library.empty")} />
        ) : (
          <ul className="flex flex-col gap-2">
            {browse.data.items.map((card) => (
              <BrowseGroupingCard
                key={card.id}
                card={card}
                isAdmin={isAdmin}
                onFork={() => handleFork(card)}
                onSubscribe={() => handleSubscribe(card)}
                onUnsubscribe={() => {
                  void actions.uninstall(card.id);
                }}
                onUpvote={() => {
                  void actions.setUpvote(card.id, !card.viewer_voted);
                }}
                onReport={(reason, details) => {
                  void actions.report(card.id, reason, details);
                }}
                onHistory={() => {
                  setHistoryId(card.id);
                  setHistoryName(card.name);
                }}
                adminActions={
                  isAdmin
                    ? {
                        adminSetOfficial: actions.adminSetOfficial,
                        adminRemove: actions.adminRemove,
                      }
                    : undefined
                }
              />
            ))}
          </ul>
        )}
      </div>

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
    </div>
  );
}

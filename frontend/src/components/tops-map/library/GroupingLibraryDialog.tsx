import { useMemo, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  Download,
  Flag,
  GitFork,
  History,
  RefreshCw,
  Trash2,
  TriangleAlert,
  ThumbsUp,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type GroupingLibrarySort,
  type LibraryGroupingCard,
  type LibraryInstallResult,
  type LibrarySubscription,
  type LibraryVersionSnapshot,
} from "@/lib/api";
import { Trans, useTranslation } from "@/lib/i18n";
import type { UseTLGroupingsResult } from "@/lib/tl-groupings";
import {
  useAdminGroupingReports,
  useGroupingLibraryActions,
  useGroupingLibraryBrowse,
  useGroupingSubscriptions,
  useMyGroupings,
} from "@/hooks/useGroupingLibrary";

import { GroupingHistoryDialog } from "./GroupingHistoryDialog";
import { PublishGroupingDialog } from "./PublishGroupingDialog";
import { ReputationBadge } from "./ReputationBadge";

interface GroupingLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  store: UseTLGroupingsResult;
  isAdmin: boolean;
}

const SORTS: GroupingLibrarySort[] = ["popular", "installs", "recent", "official"];

/** Map an install API result into the local-store payload shape. */
function toInstallPayload(result: LibraryInstallResult) {
  return {
    libraryId: result.grouping.libraryId,
    name: result.grouping.name,
    color: result.grouping.color,
    tlIds: result.grouping.tlIds,
    author: result.grouping.author,
    version: result.grouping.version,
    mode: result.mode,
  };
}

export function GroupingLibraryDialog({
  open,
  onOpenChange,
  store,
  isAdmin,
}: GroupingLibraryDialogProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"browse" | "mine" | "subscriptions" | "reports">("browse");

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<GroupingLibrarySort>("popular");
  const [officialOnly, setOfficialOnly] = useState(false);

  const browseParams = useMemo(
    () => ({ q: search.trim() || undefined, sort, officialOnly, pageSize: 30 }),
    [search, sort, officialOnly],
  );
  const browse = useGroupingLibraryBrowse(browseParams, open && tab === "browse");
  const mine = useMyGroupings(open && tab === "mine");
  const subscriptions = useGroupingSubscriptions(
    open && (tab === "subscriptions" || tab === "browse"),
  );
  const actions = useGroupingLibraryActions();

  // History + edit dialog state (hosted here so any tab can open them).
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [historyName, setHistoryName] = useState<string | undefined>();
  const [editCard, setEditCard] = useState<LibraryGroupingCard | null>(null);

  function forkSnapshotToLocal(libraryId: string, name: string, snapshot: LibraryVersionSnapshot) {
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

  async function handleUnsubscribe(sub: LibrarySubscription) {
    await actions.uninstall(sub.id);
  }

  const tabs = (
    <TabsList className="flex w-full flex-wrap">
      <TabsTrigger value="browse">{t("topsMap.groupingsDrawer.library.tabs.browse")}</TabsTrigger>
      <TabsTrigger value="mine">{t("topsMap.groupingsDrawer.library.tabs.mine")}</TabsTrigger>
      <TabsTrigger value="subscriptions">
        {t("topsMap.groupingsDrawer.library.tabs.subscriptions")}
      </TabsTrigger>
      {isAdmin && (
        <TabsTrigger value="reports">
          {t("topsMap.groupingsDrawer.library.tabs.reports")}
        </TabsTrigger>
      )}
    </TabsList>
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl" showCloseButton>
          <DialogHeader>
            <DialogTitle>{t("topsMap.groupingsDrawer.library.browseTitle")}</DialogTitle>
            <DialogDescription>
              {t("topsMap.groupingsDrawer.library.browseDescription")}
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as typeof tab)}
            className="flex min-h-0 flex-1 flex-col"
          >
            {tabs}

            <TabsContent value="browse" className="flex min-h-0 flex-1 flex-col gap-3">
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
                    <Checkbox
                      checked={officialOnly}
                      onCheckedChange={(v) => setOfficialOnly(Boolean(v))}
                    />
                    {t("topsMap.groupingsDrawer.library.officialOnly")}
                  </label>
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
                      <BrowseCardRow
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
                        isAdminFns={
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
            </TabsContent>

            <TabsContent value="mine" className="min-h-0 flex-1 overflow-y-auto">
              {mine.isLoading ? (
                <Centered>
                  <Spinner />
                </Centered>
              ) : !mine.data || mine.data.length === 0 ? (
                <EmptyState text={t("topsMap.groupingsDrawer.library.empty")} />
              ) : (
                <ul className="flex flex-col gap-2">
                  {mine.data.map((card) => (
                    <MineCardRow
                      key={card.id}
                      card={card}
                      onEdit={() => setEditCard(card)}
                      onUnpublish={() => {
                        void actions.unpublish(card.id);
                      }}
                      onHistory={() => {
                        setHistoryId(card.id);
                        setHistoryName(card.name);
                      }}
                    />
                  ))}
                </ul>
              )}
            </TabsContent>

            <TabsContent value="subscriptions" className="min-h-0 flex-1 overflow-y-auto">
              {subscriptions.isLoading ? (
                <Centered>
                  <Spinner />
                </Centered>
              ) : !subscriptions.data || subscriptions.data.length === 0 ? (
                <EmptyState text={t("topsMap.groupingsDrawer.library.empty")} />
              ) : (
                <ul className="flex flex-col gap-2">
                  {subscriptions.data.map((sub) => (
                    <SubscriptionRow
                      key={sub.id}
                      sub={sub}
                      onSync={() => handleSync(sub)}
                      onUnsubscribe={() => handleUnsubscribe(sub)}
                      onHistory={() => {
                        setHistoryId(sub.id);
                        setHistoryName(sub.name);
                      }}
                    />
                  ))}
                </ul>
              )}
            </TabsContent>

            {isAdmin && (
              <TabsContent value="reports" className="min-h-0 flex-1 overflow-y-auto">
                <AdminReportsTab />
              </TabsContent>
            )}
          </Tabs>
        </DialogContent>
      </Dialog>

      <GroupingHistoryDialog
        open={historyId !== null}
        onOpenChange={(v) => !v && setHistoryId(null)}
        groupingId={historyId}
        groupingName={historyName}
        onForkVersion={(snapshot) => {
          if (historyId) forkSnapshotToLocal(historyId, historyName ?? "", snapshot);
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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-center py-10">{children}</div>;
}

function EmptyState({ icon, text }: { icon?: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
      {icon}
      {text}
    </div>
  );
}

interface BrowseCardRowProps {
  card: LibraryGroupingCard;
  isAdmin: boolean;
  onFork: () => void | Promise<void>;
  onSubscribe: () => void | Promise<void>;
  onUnsubscribe: () => void | Promise<void>;
  onUpvote: () => void | Promise<void>;
  onReport: (reason: string, details?: string) => void | Promise<void>;
  onHistory: () => void;
  isAdminFns?: {
    adminSetOfficial: (id: string, official: boolean) => Promise<unknown>;
    adminRemove: (id: string, reason?: string) => Promise<unknown>;
  };
}

function CardHeader({ card }: { card: LibraryGroupingCard }) {
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

function BrowseCardRow({
  card,
  isAdmin,
  onFork,
  onSubscribe,
  onUnsubscribe,
  onUpvote,
  onReport,
  onHistory,
  isAdminFns,
}: BrowseCardRowProps) {
  const { t } = useTranslation();
  const [reporting, setReporting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const subscribed = card.viewer_install?.mode === "subscribe";

  return (
    <li className="rounded-md border p-2.5">
      <div className="flex items-start gap-2">
        <CardHeader card={card} />
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
        {isAdmin && isAdminFns && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void isAdminFns.adminSetOfficial(card.id, !card.is_official)}
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

      <ReportDialog
        open={reporting}
        onOpenChange={setReporting}
        groupingName={card.name}
        onSubmit={onReport}
      />

      {isAdminFns && (
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
            void isAdminFns.adminRemove(card.id);
            setRemoving(false);
          }}
          onCancel={() => setRemoving(false)}
        />
      )}
    </li>
  );
}

interface MineCardRowProps {
  card: LibraryGroupingCard;
  onEdit: () => void;
  onUnpublish: () => void | Promise<void>;
  onHistory: () => void;
}

function MineCardRow({ card, onEdit, onUnpublish, onHistory }: MineCardRowProps) {
  const { t } = useTranslation();
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  return (
    <li className="rounded-md border p-2.5">
      <CardHeader card={card} />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" onClick={onEdit}>
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
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          onClick={() => setConfirmUnpublish(true)}
        >
          <Trash2 className="size-3.5 mr-1" />
          {t("topsMap.groupingsDrawer.library.unpublish")}
        </Button>
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

interface SubscriptionRowProps {
  sub: LibrarySubscription;
  onSync: () => void | Promise<void>;
  onUnsubscribe: () => void | Promise<void>;
  onHistory: () => void;
}

function SubscriptionRow({ sub, onSync, onUnsubscribe, onHistory }: SubscriptionRowProps) {
  const { t } = useTranslation();
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
        {sub.has_update && (
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
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {sub.has_update ? (
          <Button size="sm" onClick={() => void onSync()}>
            <RefreshCw className="size-3.5 mr-1" />
            {t("topsMap.groupingsDrawer.library.syncNow")}
          </Button>
        ) : (
          <Badge variant="secondary" className="gap-1">
            <Check className="size-3" />
            {t("topsMap.groupingsDrawer.library.synced")}
          </Badge>
        )}
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

function ReportDialog({
  open,
  onOpenChange,
  groupingName,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupingName: string;
  onSubmit: (reason: string, details?: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const reasons = ["spam", "offensive", "inaccurate", "duplicate", "other"] as const;
  const [reason, setReason] = useState<(typeof reasons)[number]>("spam");
  const [details, setDetails] = useState("");
  const [done, setDone] = useState(false);

  async function submit() {
    await onSubmit(reason, details.trim() || undefined);
    setDone(true);
    setTimeout(() => {
      setDone(false);
      setDetails("");
      onOpenChange(false);
    }, 900);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("topsMap.groupingsDrawer.library.reportTitle")}</DialogTitle>
          <DialogDescription>{groupingName}</DialogDescription>
        </DialogHeader>
        {done ? (
          <p className="py-4 text-sm text-muted-foreground">
            {t("topsMap.groupingsDrawer.library.reportThanks")}
          </p>
        ) : (
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-1.5">
              {reasons.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(r)}
                  className={`rounded-md border px-2 py-1 text-xs transition-colors cursor-pointer ${
                    reason === r ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                  }`}
                >
                  {t(`topsMap.groupingsDrawer.library.reportReasons.${r}` as const)}
                </button>
              ))}
            </div>
            <textarea
              value={details}
              rows={3}
              maxLength={500}
              placeholder={t("topsMap.groupingsDrawer.library.reportDetails")}
              onChange={(e) => setDetails(e.target.value)}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <Button size="sm" onClick={() => void submit()}>
              {t("topsMap.groupingsDrawer.library.reportSubmit")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AdminReportsTab() {
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

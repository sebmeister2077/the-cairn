import { useMemo, useRef, useState } from "react";
import { Download, Globe, Pencil, Plus, Share2, Trash2, Upload } from "lucide-react";

import type { WorldLineSegment } from "@/components/MapViewer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  parseImport,
  serializeForExport,
  tlIdFor,
  type TLGrouping,
  type UseTLGroupingsResult,
} from "@/lib/tl-groupings";
import { useGroupingSubscriptions } from "@/hooks/useGroupingLibrary";
import { useAppSelector } from "@/store/hooks";
import { Trans, useTranslation } from "@/lib/i18n";
import { GroupingLibraryDialog } from "./library/GroupingLibraryDialog";
import { PublishGroupingDialog } from "./library/PublishGroupingDialog";

export type TLGroupingsViewMode = "all" | "filter" | "highlight";

interface TLGroupingsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  store: UseTLGroupingsResult;

  /** All TL segments currently loaded for the page, used for "missing" counts. */
  allSegments: WorldLineSegment[];

  viewMode: TLGroupingsViewMode;
  onViewModeChange: (mode: TLGroupingsViewMode) => void;

  activeGroupingIds: ReadonlySet<string>;
  onToggleActive: (id: string) => void;

  editingGroupingId: string | null;
  onStartEditing: (id: string) => void;
  onStopEditing: () => void;
}

/**
 * Right-side sheet that lists the user's TL groupings and surfaces the
 * controls used by the favorites feature: per-grouping activate / edit /
 * delete / rename, view-mode segmented control, and JSON import/export.
 */
export function TLGroupingsDrawer({
  open,
  onOpenChange,
  store,
  allSegments,
  viewMode,
  onViewModeChange,
  activeGroupingIds,
  onToggleActive,
  editingGroupingId,
  onStartEditing,
  onStopEditing,
}: TLGroupingsDrawerProps) {
  const { t } = useTranslation();
  const { groupings, createGrouping, renameGrouping, deleteGrouping, importJSON } = store;

  const isAdmin = useAppSelector((s) => s.auth.isAdmin);
  const apiKey = useAppSelector((s) => s.auth.apiKey);
  const signedIn = Boolean(apiKey);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingImport, setPendingImport] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TLGrouping | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // Community library dialog + per-grouping publish dialog state.
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [publishTarget, setPublishTarget] = useState<TLGrouping | null>(null);

  // Surface a badge on the library button when any subscribed grouping has an
  // upstream update. Only queried while signed in.
  const subscriptions = useGroupingSubscriptions(signedIn && open);
  const updateCount = useMemo(
    () => (subscriptions.data ?? []).filter((s) => s.has_update).length,
    [subscriptions.data],
  );

  // Set of canonical TLIds present in the currently-loaded geojson, used to
  // surface "(N missing)" indicators when a grouping references TLs that no
  // longer exist (e.g. after a static asset update). We never auto-prune
  // those entries — we just inform the user.
  const loadedTLIdSet = useMemo(() => {
    const set = new Set<string>();
    for (const seg of allSegments) set.add(tlIdFor(seg));
    return set;
  }, [allSegments]);

  function handleCreate() {
    const grouping = createGrouping(
      t("topsMap.groupingsDrawer.defaultGroupingName", { count: groupings.length + 1 }),
    );
    onStartEditing(grouping.id);
  }

  function handleExport() {
    const json = serializeForExport(groupings);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `tops-tl-groupings-${date}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    const text = await file.text();
    const parsed = parseImport(text);
    if (!parsed) {
      setImportError(t("topsMap.groupingsDrawer.invalidImport"));
      return;
    }
    setImportError(null);
    setPendingImport(text);
  }

  function applyImport(mode: "replace" | "merge") {
    if (!pendingImport) return;
    const result = importJSON(pendingImport, mode);
    setPendingImport(null);
    if (!result.ok) setImportError(t("topsMap.groupingsDrawer.invalidImport"));
  }

  function startRename(g: TLGrouping) {
    setRenamingId(g.id);
    setRenameDraft(g.name);
  }

  function commitRename() {
    if (renamingId) renameGrouping(renamingId, renameDraft);
    setRenamingId(null);
    setRenameDraft("");
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{t("topsMap.groupingsDrawer.title")}</SheetTitle>
            <SheetDescription>{t("topsMap.groupingsDrawer.description")}</SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-1">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              {t("topsMap.groupingsDrawer.viewMode")}
            </Label>
            <div className="inline-flex w-full overflow-hidden rounded-md border">
              {(
                [
                  { value: "all", label: t("topsMap.groupingsDrawer.modes.all") },
                  { value: "filter", label: t("topsMap.groupingsDrawer.modes.filter") },
                  { value: "highlight", label: t("topsMap.groupingsDrawer.modes.highlight") },
                ] as const
              ).map((opt) => {
                const active = viewMode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => onViewModeChange(opt.value)}
                    className={`flex-1 px-2 py-1.5 text-xs transition-colors cursor-pointer ${
                      active ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {viewMode === "all" && t("topsMap.groupingsDrawer.modeHelp.all")}
              {viewMode === "filter" && t("topsMap.groupingsDrawer.modeHelp.filter")}
              {viewMode === "highlight" && t("topsMap.groupingsDrawer.modeHelp.highlight")}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={handleImportClick}>
              <Download className="size-4 mr-1" /> {t("topsMap.groupingsDrawer.import")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleExport}
              disabled={groupings.length === 0}
            >
              <Upload className="size-4 mr-1" /> {t("topsMap.groupingsDrawer.export")}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              hidden
              onChange={handleFileChange}
            />
          </div>
          {importError && <p className="text-xs text-destructive">{importError}</p>}

          <Button
            type="button"
            size="sm"
            variant="outline"
            className="relative"
            onClick={() => setLibraryOpen(true)}
          >
            <Globe className="size-4 mr-1" />
            {t("topsMap.groupingsDrawer.library.browse")}
            {updateCount > 0 && (
              <Badge className="ml-2" variant="default">
                {updateCount}
              </Badge>
            )}
          </Button>

          <div className="flex-1 overflow-y-auto -mx-4 px-4">
            {groupings.length === 0 && (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                {t("topsMap.groupingsDrawer.empty")}
              </div>
            )}

            <ul className="flex flex-col gap-2">
              {groupings.map((g) => {
                const isActive = activeGroupingIds.has(g.id);
                const isEditing = editingGroupingId === g.id;
                const total = g.tlIds.length;
                const missing = g.tlIds.filter((id) => !loadedTLIdSet.has(id)).length;
                return (
                  <li
                    key={g.id}
                    className={`rounded-md border p-2 transition-colors ${
                      isEditing ? "border-primary bg-primary/5" : ""
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <Checkbox
                        className="mt-1.5 cursor-pointer"
                        checked={isActive}
                        onCheckedChange={() => onToggleActive(g.id)}
                        aria-label={t("topsMap.groupingsDrawer.activateGrouping", { name: g.name })}
                      />
                      <div className="flex-1 min-w-0">
                        {renamingId === g.id ? (
                          <input
                            autoFocus
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRename();
                              if (e.key === "Escape") {
                                setRenamingId(null);
                                setRenameDraft("");
                              }
                            }}
                            className="block w-full bg-transparent font-medium outline-none border-b border-primary focus:outline-none"
                          />
                        ) : (
                          <button
                            type="button"
                            className="block w-full truncate text-left font-medium hover:underline"
                            onClick={() => startRename(g)}
                            title={t("topsMap.groupingsDrawer.clickToRename")}
                          >
                            {g.name}
                          </button>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {t("topsMap.groupingsDrawer.tlCount", { count: total })}
                          {missing > 0
                            ? ` (${t("topsMap.groupingsDrawer.missingCount", { count: missing })})`
                            : ""}
                        </p>
                        {g.source?.mode === "subscribe" && (
                          <p className="text-[11px] text-muted-foreground">
                            {t("topsMap.groupingsDrawer.library.installedSubscribe")}
                          </p>
                        )}
                        {g.source?.mode === "fork" && (
                          <p className="text-[11px] text-muted-foreground">
                            {t("topsMap.groupingsDrawer.library.installedFork")}
                          </p>
                        )}
                        {!g.source && g.publishedId && (
                          <p className="text-[11px] text-muted-foreground">
                            {t("topsMap.groupingsDrawer.library.publishedIndicator")}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {signedIn && g.source?.mode !== "subscribe" && (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => setPublishTarget(g)}
                            title={
                              g.publishedId
                                ? t("topsMap.groupingsDrawer.library.publishUpdate")
                                : t("topsMap.groupingsDrawer.library.publish")
                            }
                          >
                            <Share2 className="size-4" />
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="icon-sm"
                          variant={isEditing ? "default" : "ghost"}
                          onClick={() => (isEditing ? onStopEditing() : onStartEditing(g.id))}
                          title={
                            isEditing
                              ? t("topsMap.groupingsDrawer.stopEditing")
                              : t("topsMap.groupingsDrawer.editTls")
                          }
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => setConfirmDelete(g)}
                          title={t("topsMap.groupingsDrawer.deleteGrouping")}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          <Button type="button" onClick={handleCreate}>
            <Plus className="size-4 mr-1" /> {t("topsMap.groupingsDrawer.newGrouping")}
          </Button>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("topsMap.groupingsDrawer.deleteTitle")}
        description={
          confirmDelete ? (
            <Trans
              path="topsMap.groupingsDrawer.deleteDescription"
              values={{ name: confirmDelete.name }}
              components={{ strong: <strong /> }}
            />
          ) : undefined
        }
        confirmLabel={t("topsMap.groupingsDrawer.deleteConfirm")}
        cancelLabel={t("topsMap.groupingsDrawer.cancel")}
        variant="destructive"
        onConfirm={() => {
          if (confirmDelete) deleteGrouping(confirmDelete.id);
          setConfirmDelete(null);
        }}
        onCancel={() => setConfirmDelete(null)}
      />

      <Dialog
        open={pendingImport !== null}
        onOpenChange={(v) => {
          if (!v) setPendingImport(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("topsMap.groupingsDrawer.importTitle")}</DialogTitle>
            <DialogDescription>{t("topsMap.groupingsDrawer.importDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setPendingImport(null)}>
              {t("topsMap.groupingsDrawer.cancel")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => applyImport("replace")}>
              {t("topsMap.groupingsDrawer.replace")}
            </Button>
            <Button size="sm" onClick={() => applyImport("merge")}>
              {t("topsMap.groupingsDrawer.merge")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <GroupingLibraryDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        store={store}
        isAdmin={isAdmin}
      />

      <PublishGroupingDialog
        open={publishTarget !== null}
        onOpenChange={(v) => {
          if (!v) setPublishTarget(null);
        }}
        grouping={publishTarget}
        editLibraryId={publishTarget?.publishedId}
        onPublished={(libraryId) => {
          if (publishTarget) store.markPublished(publishTarget.id, libraryId);
          setPublishTarget(null);
        }}
      />
    </>
  );
}

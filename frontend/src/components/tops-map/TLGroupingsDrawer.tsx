import { useMemo, useRef, useState } from "react";
import { Download, Pencil, Plus, Trash2, Upload } from "lucide-react";

import type { WorldLineSegment } from "@/components/MapViewer";
import { Button } from "@/components/ui/button";
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
  const { groupings, createGrouping, renameGrouping, deleteGrouping, importJSON } = store;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingImport, setPendingImport] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TLGrouping | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

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
    const grouping = createGrouping(`Grouping ${groupings.length + 1}`);
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
      setImportError("That file is not a valid TL groupings export.");
      return;
    }
    setImportError(null);
    setPendingImport(text);
  }

  function applyImport(mode: "replace" | "merge") {
    if (!pendingImport) return;
    const result = importJSON(pendingImport, mode);
    setPendingImport(null);
    if (!result.ok) setImportError(result.error);
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
            <SheetTitle>Favorite TL groupings</SheetTitle>
            <SheetDescription>
              Save sets of translocators you care about and reduce on-map clutter. Stored locally in
              this browser.
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-1">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              View mode
            </Label>
            <div className="inline-flex w-full overflow-hidden rounded-md border">
              {(
                [
                  { value: "all", label: "All TLs" },
                  { value: "filter", label: "Only selected" },
                  { value: "highlight", label: "Highlight selected" },
                ] as const
              ).map((opt) => {
                const active = viewMode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => onViewModeChange(opt.value)}
                    className={`flex-1 px-2 py-1.5 text-xs transition-colors ${
                      active ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {viewMode === "all" && "Groupings have no effect on what's drawn."}
              {viewMode === "filter" && "Only TLs in the active groupings are rendered."}
              {viewMode === "highlight" && "All TLs are rendered; favorites are emphasised."}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={handleImportClick}>
              <Download className="size-4 mr-1" /> Import
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleExport}
              disabled={groupings.length === 0}
            >
              <Upload className="size-4 mr-1" /> Export
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

          <div className="flex-1 overflow-y-auto -mx-4 px-4">
            {groupings.length === 0 && (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No groupings yet. Create one and click TLs on the map to add them.
              </div>
            )}
            {groupings.length > 0 && (
              <p className="mb-2 text-[11px] text-muted-foreground">
                Tip: click a grouping’s name to rename it. Use the pencil icon to add or remove TLs
                from the grouping by clicking them on the map.
              </p>
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
                        aria-label={`Activate grouping ${g.name}`}
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
                            title="Click to rename"
                          >
                            {g.name}
                          </button>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {total} TL{total === 1 ? "" : "s"}
                          {missing > 0 ? ` (${missing} missing)` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          size="icon-sm"
                          variant={isEditing ? "default" : "ghost"}
                          onClick={() => (isEditing ? onStopEditing() : onStartEditing(g.id))}
                          title={isEditing ? "Stop editing" : "Edit TLs"}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => setConfirmDelete(g)}
                          title="Delete grouping"
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
            <Plus className="size-4 mr-1" /> New grouping
          </Button>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete grouping?"
        description={
          confirmDelete
            ? `“${confirmDelete.name}” will be removed from this browser. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete"
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
            <DialogTitle>Import groupings</DialogTitle>
            <DialogDescription>
              Replace your existing groupings with the imported file, or merge them into your
              current list?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setPendingImport(null)}>
              Cancel
            </Button>
            <Button variant="outline" size="sm" onClick={() => applyImport("replace")}>
              Replace
            </Button>
            <Button size="sm" onClick={() => applyImport("merge")}>
              Merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

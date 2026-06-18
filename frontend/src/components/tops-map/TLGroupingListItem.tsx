import { useEffect, useRef, useState } from "react";
import { Pencil, Share2, Trash2 } from "lucide-react";
import { useDebounceCallback } from "@react-hook/debounce";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { TLGrouping } from "@/lib/tl-groupings";
import { useTranslation } from "@/lib/i18n";

/** How long to wait after the last color-picker change before propagating
 *  the new color to the store. The native `<input type="color">` fires
 *  `onChange` on every drag step, which would otherwise re-render the entire
 *  map overlay (and re-bucket every TL segment by color) on every pixel of
 *  picker movement. */
const COLOR_DEBOUNCE_MS = 150;

interface TLGroupingListItemProps {
  grouping: TLGrouping;
  isActive: boolean;
  isEditing: boolean;
  /** Set of canonical TLIds present in the currently-loaded geojson, used to
   * surface "(N missing)" indicators when a grouping references TLs that no
   * longer exist. */
  loadedTLIdSet: ReadonlySet<string>;
  signedIn: boolean;

  onToggleActive: (id: string) => void;
  onStartEditing: (id: string) => void;
  onStopEditing: () => void;
  onRename: (id: string, name: string) => void;
  onSetColor: (id: string, color: string | undefined) => void;
  onRequestDelete: (g: TLGrouping) => void;
  onRequestPublish: (g: TLGrouping) => void;
}

/** Default color used in the picker when a grouping has no saved color yet.
 *  Matches the seeded-TL purple in the map viewer so the swatch reads as
 *  "the regular color" by default. */
const DEFAULT_COLOR = "#a855f7";

/**
 * Single row in the favorite groupings drawer. Owns its inline rename state;
 * the parent drives "currently editing" and "currently active" via props.
 */
export function TLGroupingListItem({
  grouping: g,
  isActive,
  isEditing,
  loadedTLIdSet,
  signedIn,
  onToggleActive,
  onStartEditing,
  onStopEditing,
  onRename,
  onSetColor,
  onRequestDelete,
  onRequestPublish,
}: TLGroupingListItemProps) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");

  // Local mirror of the swatch value so the picker stays responsive while we
  // hold off on dispatching the store update. Resyncs when the prop changes
  // from the outside (e.g. import / library subscribe refresh).
  const [colorDraft, setColorDraft] = useState<string>(g.color ?? DEFAULT_COLOR);
  useEffect(() => {
    setColorDraft(g.color ?? DEFAULT_COLOR);
  }, [g.color]);
  // Track the latest pending color so `flushColor` can dispatch it
  // immediately on blur without waiting for the trailing timer.
  const pendingColorRef = useRef<string | null>(null);
  const debouncedSetColor = useDebounceCallback((id: string, color: string) => {
    pendingColorRef.current = null;
    onSetColor(id, color);
  }, COLOR_DEBOUNCE_MS);

  const total = g.tlIds.length;
  const missing = g.tlIds.filter((id) => !loadedTLIdSet.has(id)).length;

  function handleColorChange(next: string) {
    setColorDraft(next);
    pendingColorRef.current = next;
    debouncedSetColor(g.id, next);
  }

  function flushColor() {
    const pending = pendingColorRef.current;
    if (pending == null) return;
    pendingColorRef.current = null;
    onSetColor(g.id, pending);
  }

  function startRename() {
    setRenaming(true);
    setRenameDraft(g.name);
  }

  function commitRename() {
    if (renaming) onRename(g.id, renameDraft);
    setRenaming(false);
    setRenameDraft("");
  }

  return (
    <li
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
          {renaming ? (
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") {
                  setRenaming(false);
                  setRenameDraft("");
                }
              }}
              className="block w-full bg-transparent font-medium outline-none border-b border-primary focus:outline-none"
            />
          ) : (
            <button
              type="button"
              className="block w-full truncate text-left font-medium hover:underline"
              onClick={startRename}
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
          <input
            type="color"
            value={colorDraft}
            onChange={(e) => handleColorChange(e.target.value)}
            onBlur={flushColor}
            title={t("topsMap.groupingsDrawer.pickColor")}
            aria-label={t("topsMap.groupingsDrawer.pickColor")}
            className="size-7 cursor-pointer rounded border border-input bg-transparent p-0.5"
          />
          {signedIn && g.source?.mode !== "subscribe" && (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={() => onRequestPublish(g)}
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
            onClick={() => onRequestDelete(g)}
            title={t("topsMap.groupingsDrawer.deleteGrouping")}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
    </li>
  );
}

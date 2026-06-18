import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import type { TLGrouping } from "@/lib/tl-groupings";
import { useGroupingLibraryActions } from "@/hooks/useGroupingLibrary";

import { TagInput } from "./TagInput";

interface PublishGroupingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The local grouping being published / updated. */
  grouping: TLGrouping | null;
  /**
   * When set, the dialog edits an already-published grouping (PATCH) using
   * this library id instead of creating a new one. Usually
   * `grouping.source?.libraryId`.
   */
  editLibraryId?: string;
  /** Called after a successful publish with the new library id + version. */
  onPublished?: (libraryId: string, version: number) => void;
}

interface DuplicateConflict {
  id: string;
  name: string;
}

const MAX_TAGS = 5;

/**
 * Form dialog to publish a local grouping to the community library, or to push
 * an update to one the user already owns. Surfaces the backend's structured
 * error codes (account too new, daily caps, duplicate-tlIds 409) as friendly
 * inline UI.
 */
export function PublishGroupingDialog({
  open,
  onOpenChange,
  grouping,
  editLibraryId,
  onPublished,
}: PublishGroupingDialogProps) {
  const { t } = useTranslation();
  const actions = useGroupingLibraryActions();
  const isEdit = Boolean(editLibraryId);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("");
  const [tagList, setTagList] = useState<string[]>([]);
  const [changeNote, setChangeNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [duplicate, setDuplicate] = useState<DuplicateConflict | null>(null);

  useEffect(() => {
    if (open && grouping) {
      setName(grouping.name);
      setColor(grouping.color ?? "");
      setDescription("");
      setTagList([]);
      setChangeNote("");
      setError(null);
      setDuplicate(null);
    }
  }, [open, grouping]);

  function mapError(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.code === "account_too_new") return t("topsMap.groupingsDrawer.library.accountTooNew");
      if (err.code === "empty_grouping") return t("topsMap.groupingsDrawer.library.emptyGrouping");
      if (err.status === 429) {
        return isEdit
          ? t("topsMap.groupingsDrawer.library.editCapHit")
          : t("topsMap.groupingsDrawer.library.publishCapHit");
      }
      if (typeof err.detail === "object" && err.detail?.message) return err.detail.message;
      return err.message;
    }
    return t("common.unknownError");
  }

  /** Pull `{id, name}` out of a 409 duplicate-payload response, if present. */
  function extractDuplicate(err: unknown): DuplicateConflict | null {
    if (!(err instanceof ApiError) || err.status !== 409) return null;
    if (err.code !== "duplicate_payload") return null;
    const detail = err.detail as { existing?: { id?: unknown; name?: unknown } } | undefined;
    const ex = detail?.existing;
    if (!ex || typeof ex.id !== "string" || typeof ex.name !== "string") return null;
    return { id: ex.id, name: ex.name };
  }

  async function submit(allowDuplicate: boolean) {
    if (!grouping) return;
    setBusy(true);
    setError(null);
    setDuplicate(null);
    try {
      const colorValue = color.trim() || null;
      if (isEdit && editLibraryId) {
        const card = await actions.edit(editLibraryId, {
          name: name.trim(),
          description: description.trim() || null,
          color: colorValue,
          tlIds: grouping.tlIds,
          tags: tagList,
          changeNote: changeNote.trim() || undefined,
          allowDuplicate,
        });
        onPublished?.(card.id, card.version);
      } else {
        const card = await actions.publish({
          name: name.trim(),
          description: description.trim() || null,
          color: colorValue,
          tlIds: grouping.tlIds,
          tags: tagList,
          allowDuplicate,
        });
        onPublished?.(card.id, card.version);
      }
      onOpenChange(false);
    } catch (err) {
      const dup = extractDuplicate(err);
      if (dup) {
        setDuplicate(dup);
      } else {
        setError(mapError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  const tlCount = grouping?.tlIds.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("topsMap.groupingsDrawer.library.editTitle")
              : t("topsMap.groupingsDrawer.library.publishTitle")}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? t("topsMap.groupingsDrawer.library.editDescription")
              : t("topsMap.groupingsDrawer.library.publishDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="publish-name">{t("topsMap.groupingsDrawer.library.nameLabel")}</Label>
            <Input
              id="publish-name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="publish-desc">
              {t("topsMap.groupingsDrawer.library.descriptionLabel")}
            </Label>
            <textarea
              id="publish-desc"
              value={description}
              maxLength={500}
              rows={3}
              placeholder={t("topsMap.groupingsDrawer.library.descriptionPlaceholder")}
              onChange={(e) => setDescription(e.target.value)}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
          <div className="grid gap-1.5">
            <div className="flex items-center gap-2">
              <Label htmlFor="publish-color">
                {t("topsMap.groupingsDrawer.library.colorLabel")}
              </Label>
              <input
                id="publish-color"
                type="color"
                value={color || "#a855f7"}
                onChange={(e) => setColor(e.target.value)}
                className="h-8 w-12 cursor-pointer rounded border border-input bg-transparent"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("topsMap.groupingsDrawer.library.colorHint")}
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="publish-tags">{t("topsMap.groupingsDrawer.library.tagsLabel")}</Label>
            <TagInput
              id="publish-tags"
              value={tagList}
              onChange={setTagList}
              max={MAX_TAGS}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">
              {t("topsMap.groupingsDrawer.library.tagsHint", { max: MAX_TAGS })}
            </p>
          </div>
          {isEdit && (
            <div className="grid gap-1.5">
              <Label htmlFor="publish-note">
                {t("topsMap.groupingsDrawer.library.changeNoteLabel")}
              </Label>
              <Input
                id="publish-note"
                value={changeNote}
                maxLength={200}
                placeholder={t("topsMap.groupingsDrawer.library.changeNotePlaceholder")}
                onChange={(e) => setChangeNote(e.target.value)}
              />
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {t("topsMap.groupingsDrawer.library.tls", { count: tlCount })}
          </p>
          {duplicate && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5 text-sm">
              <p className="font-medium">
                {t("topsMap.groupingsDrawer.library.duplicatePayloadTitle")}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {t("topsMap.groupingsDrawer.library.duplicatePayload", {
                  name: duplicate.name,
                })}
              </p>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("topsMap.groupingsDrawer.cancel")}
          </Button>
          {duplicate ? (
            <Button size="sm" variant="secondary" onClick={() => void submit(true)} disabled={busy}>
              {t("topsMap.groupingsDrawer.library.duplicatePayloadPublishAnyway")}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void submit(false)}
              disabled={busy || !name.trim() || tlCount === 0}
            >
              {busy
                ? t("topsMap.groupingsDrawer.library.publishing")
                : isEdit
                  ? t("topsMap.groupingsDrawer.library.updateConfirm")
                  : t("topsMap.groupingsDrawer.library.publishConfirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

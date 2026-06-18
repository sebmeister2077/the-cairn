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

function splitTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Form dialog to publish a local grouping to the community library, or to push
 * an update to one the user already owns. Surfaces the backend's structured
 * error codes (account too new, daily caps) as friendly inline messages.
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
  const [tags, setTags] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && grouping) {
      setName(grouping.name);
      setColor(grouping.color ?? "");
      setDescription("");
      setTags("");
      setChangeNote("");
      setError(null);
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

  async function handleSubmit() {
    if (!grouping) return;
    setBusy(true);
    setError(null);
    try {
      const tagList = splitTags(tags);
      const colorValue = color.trim() || null;
      if (isEdit && editLibraryId) {
        const card = await actions.edit(editLibraryId, {
          name: name.trim(),
          description: description.trim() || null,
          color: colorValue,
          tlIds: grouping.tlIds,
          tags: tagList,
          changeNote: changeNote.trim() || undefined,
        });
        onPublished?.(card.id, card.version);
      } else {
        const card = await actions.publish({
          name: name.trim(),
          description: description.trim() || null,
          color: colorValue,
          tlIds: grouping.tlIds,
          tags: tagList,
        });
        onPublished?.(card.id, card.version);
      }
      onOpenChange(false);
    } catch (err) {
      setError(mapError(err));
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
            <Input
              id="publish-tags"
              value={tags}
              placeholder={t("topsMap.groupingsDrawer.library.tagsPlaceholder")}
              onChange={(e) => setTags(e.target.value)}
            />
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
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("topsMap.groupingsDrawer.cancel")}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={busy || !name.trim() || tlCount === 0}>
            {busy
              ? t("topsMap.groupingsDrawer.library.publishing")
              : isEdit
                ? t("topsMap.groupingsDrawer.library.updateConfirm")
                : t("topsMap.groupingsDrawer.library.publishConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

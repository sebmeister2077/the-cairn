import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

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
import { ApiError, groupingLibrary } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import type { TLGrouping } from "@/lib/tl-groupings";
import { GROUPING_LIBRARY_KEY, useGroupingLibraryActions } from "@/hooks/useGroupingLibrary";

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
  // Set when the library entry referenced by `editLibraryId` no longer exists
  // (deleted by the publisher, an admin, or wiped from the DB). We fall back
  // to a fresh publish so the user isn't stranded with a stale `publishedId`.
  const [originalMissing, setOriginalMissing] = useState(false);

  // In edit mode, fetch the existing published card so we can prefill
  // description / tags / color (the local TLGrouping doesn't store those
  // fields). Cached and shared with other library views. Don't retry on 404 —
  // that's the "library entry gone" signal we want to surface immediately.
  const cardQuery = useQuery({
    queryKey: [...GROUPING_LIBRARY_KEY, "card", editLibraryId],
    queryFn: ({ signal }) => groupingLibrary.get(editLibraryId as string, signal),
    enabled: open && Boolean(editLibraryId),
    staleTime: 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });

  const effectiveEdit = isEdit && !originalMissing;

  // One-shot guard so the prefill from the fetched card doesn't clobber
  // user edits after the first successful seed in this open cycle.
  const cardSeededRef = useRef(false);

  useEffect(() => {
    if (!open) {
      cardSeededRef.current = false;
      return;
    }
    if (!grouping) return;
    setName(grouping.name);
    setColor(grouping.color ?? "");
    setDescription("");
    setTagList([]);
    setChangeNote("");
    setError(null);
    setDuplicate(null);
    setOriginalMissing(false);
  }, [open, grouping]);

  useEffect(() => {
    if (!open || !isEdit) return;
    if (cardSeededRef.current) return;
    const card = cardQuery.data;
    if (!card) return;
    cardSeededRef.current = true;
    setName(card.name);
    setColor(card.color ?? "");
    setDescription(card.description ?? "");
    setTagList(card.tags ?? []);
  }, [open, isEdit, cardQuery.data]);

  // The published entry was deleted server-side. Switch to publish-new mode
  // so the user can re-share their local copy instead of hitting 404 forever.
  useEffect(() => {
    if (!open || !isEdit) return;
    const err = cardQuery.error;
    if (err instanceof ApiError && err.status === 404) {
      setOriginalMissing(true);
    }
  }, [open, isEdit, cardQuery.error]);

  function mapError(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.code === "account_too_new") return t("topsMap.groupingsDrawer.library.accountTooNew");
      if (err.code === "empty_grouping") return t("topsMap.groupingsDrawer.library.emptyGrouping");
      if (err.status === 429) {
        return effectiveEdit
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
      const basePayload = {
        name: name.trim(),
        description: description.trim() || null,
        color: colorValue,
        tlIds: grouping.tlIds,
        tags: tagList,
        allowDuplicate,
      };
      let card;
      if (effectiveEdit && editLibraryId) {
        try {
          card = await actions.edit(editLibraryId, {
            ...basePayload,
            changeNote: changeNote.trim() || undefined,
          });
        } catch (err) {
          // The library entry was deleted between the dialog opening and
          // submit. Fall back to a fresh publish so the user isn't stuck.
          if (err instanceof ApiError && err.status === 404) {
            setOriginalMissing(true);
            card = await actions.publish(basePayload);
          } else {
            throw err;
          }
        }
      } else {
        card = await actions.publish(basePayload);
      }
      onPublished?.(card.id, card.version);
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
            {effectiveEdit
              ? t("topsMap.groupingsDrawer.library.editTitle")
              : t("topsMap.groupingsDrawer.library.publishTitle")}
          </DialogTitle>
          <DialogDescription>
            {effectiveEdit
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
          {effectiveEdit && (
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
          {originalMissing && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5 text-sm">
              <p className="font-medium">
                {t("topsMap.groupingsDrawer.library.originalMissingTitle")}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {t("topsMap.groupingsDrawer.library.originalMissing")}
              </p>
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
                : effectiveEdit
                  ? t("topsMap.groupingsDrawer.library.updateConfirm")
                  : t("topsMap.groupingsDrawer.library.publishConfirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

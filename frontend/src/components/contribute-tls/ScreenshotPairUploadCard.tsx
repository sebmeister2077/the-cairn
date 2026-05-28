/**
 * Screenshot pair upload card.
 *
 * User picks two PNG screenshots — each MUST show:
 *   - the in-game minimap (top-right of the HUD), and
 *   - the player's coordinate readout (default: bottom of HUD).
 *
 * The browser:
 *   1. requests two presigned PUT URLs from the backend,
 *   2. uploads the PNGs directly to R2,
 *   3. calls /complete which inserts the DB row and queues OCR + minimap match.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { NavLink } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ClipboardPaste, Loader2, Upload, X } from "lucide-react";
import {
  ApiError,
  completeTLScreenshotUpload,
  requestTLScreenshotUploadUrls,
  uploadScreenshotToR2,
} from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { MaintenanceChip } from "../MaintenanceChip";

const MAX_BYTES = 8 * 1024 * 1024;
const ACCEPTED_TYPES = ["image/png"];

interface SlotState {
  file: File | null;
  previewUrl: string | null;
  error: string | null;
}

const EMPTY_SLOT: SlotState = { file: null, previewUrl: null, error: null };

interface Props {
  onSubmitted?: (requestId: string) => void;
}

export function ScreenshotPairUploadCard({ onSubmitted }: Props) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [slotA, setSlotA] = useState<SlotState>(EMPTY_SLOT);
  const [slotB, setSlotB] = useState<SlotState>(EMPTY_SLOT);
  const [label, setLabel] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pasteHint, setPasteHint] = useState<string | null>(null);
  // Refs hold the latest slot state so the global paste handler stays stable.
  const slotARef = useRef(slotA);
  const slotBRef = useRef(slotB);
  useEffect(() => {
    slotARef.current = slotA;
  }, [slotA]);
  useEffect(() => {
    slotBRef.current = slotB;
  }, [slotB]);

  const pickFile = useCallback(
    (file: File | null, slot: "a" | "b") => {
      const setter = slot === "a" ? setSlotA : setSlotB;
      if (file == null) {
        setter(EMPTY_SLOT);
        return;
      }
      if (!ACCEPTED_TYPES.includes(file.type)) {
        setter({
          file: null,
          previewUrl: null,
          error: t("contributeTLsPage.screenshots.pngOnly"),
        });
        return;
      }
      if (file.size > MAX_BYTES) {
        setter({
          file: null,
          previewUrl: null,
          error: t("contributeTLsPage.screenshots.imageTooLarge", {
            size: Math.round(file.size / 1024),
            max: MAX_BYTES / 1024,
          }),
        });
        return;
      }
      setter({
        file,
        previewUrl: URL.createObjectURL(file),
        error: null,
      });
    },
    [t],
  );

  // Decide which slot a pasted/dropped image should fill.
  const targetSlotForPaste = useCallback((): "a" | "b" | null => {
    const aEmpty = slotARef.current.file == null;
    const bEmpty = slotBRef.current.file == null;
    if (aEmpty) return "a";
    if (bEmpty) return "b";
    return null;
  }, []);

  const acceptPastedImage = useCallback(
    (file: File, preferredSlot?: "a" | "b") => {
      const slot = preferredSlot ?? targetSlotForPaste();
      if (slot == null) {
        setPasteHint(t("contributeTLsPage.screenshots.bothSlotsFilled"));
        return;
      }
      // Snipping Tool drops files as "image.png"; give them a more useful name.
      const named =
        file.name && file.name !== "image.png"
          ? file
          : new File([file], `pasted-screenshot-${slot}-${Date.now()}.png`, { type: file.type });
      pickFile(named, slot);
      setPasteHint(t("contributeTLsPage.screenshots.pastedInto", { slot: slot.toUpperCase() }));
    },
    [pickFile, t, targetSlotForPaste],
  );

  // Global paste handler scoped to when the card is mounted. Active anywhere
  // on the page so users don't have to click the card first after using
  // Shift+Win+S.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            acceptPastedImage(file);
            return;
          }
        }
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptPastedImage]);

  const pasteFromClipboardButton = useCallback(
    async (slot: "a" | "b") => {
      setPasteHint(null);
      // navigator.clipboard.read is available in Chromium-based browsers and
      // requires a secure context + user gesture (this click satisfies both).
      const clipboard = navigator.clipboard as Clipboard & {
        read?: () => Promise<ClipboardItems>;
      };
      if (typeof clipboard.read !== "function") {
        setPasteHint(t("contributeTLsPage.screenshots.browserClipboardUnsupported"));
        return;
      }
      try {
        const items = await clipboard.read();
        for (const item of items) {
          const pngType =
            item.types.find((t) => t === "image/png") ??
            item.types.find((t) => t.startsWith("image/"));
          if (pngType) {
            const blob = await item.getType(pngType);
            const file = new File([blob], `pasted-screenshot-${slot}-${Date.now()}.png`, {
              type: pngType,
            });
            acceptPastedImage(file, slot);
            return;
          }
        }
        setPasteHint(t("contributeTLsPage.screenshots.noImageOnClipboard"));
      } catch (err) {
        setPasteHint(
          err instanceof Error && err.name === "NotAllowedError"
            ? t("contributeTLsPage.screenshots.clipboardPermissionDenied")
            : t("contributeTLsPage.screenshots.clipboardReadFailed"),
        );
      }
    },
    [acceptPastedImage, t],
  );

  const mutation = useMutation({
    mutationFn: async () => {
      if (!slotA.file || !slotB.file) {
        throw new Error(t("contributeTLsPage.screenshots.bothRequired"));
      }
      const urls = await requestTLScreenshotUploadUrls();
      // Upload both in parallel; if either fails the request stays pending
      // but the worker will eventually fail it with a download error.
      await Promise.all([
        uploadScreenshotToR2(urls.upload_url_a, slotA.file),
        uploadScreenshotToR2(urls.upload_url_b, slotB.file),
      ]);
      return await completeTLScreenshotUpload(urls.request_id, label.trim() || null);
    },
    onSuccess: (req) => {
      setSlotA(EMPTY_SLOT);
      setSlotB(EMPTY_SLOT);
      setLabel("");
      setSubmitError(null);
      setPasteHint(null);
      queryClient.invalidateQueries({ queryKey: ["my-tl-screenshot-requests"] });
      onSubmitted?.(req.id);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        const detail = err.message;
        if (err.status === 404) {
          setSubmitError(t("contributeTLsPage.screenshots.disabled"));
          return;
        }
        if (err.status === 403) {
          setSubmitError(t("contributeTLsPage.screenshots.needsAccount"));
          return;
        }
        if (err.status === 429) {
          setSubmitError(
            typeof detail === "string" ? detail : t("contributeTLsPage.screenshots.tooManyPending"),
          );
          return;
        }
        setSubmitError(typeof detail === "string" ? detail : `HTTP ${err.status}`);
        return;
      }
      setSubmitError(
        err instanceof Error ? err.message : t("contributeTLsPage.screenshots.submissionFailed"),
      );
    },
  });

  const canSubmit = slotA.file != null && slotB.file != null && !mutation.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t("contributeTLsPage.screenshots.title")}
          <MaintenanceChip component="tops_contribute_tls_screenshot" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("contributeTLsPage.screenshots.descriptionPrefix")} <code>X=1234 Y=110 Z=-5678</code>
          {t("contributeTLsPage.screenshots.descriptionSuffix")}{" "}
          <NavLink
            to="/blog/submitting-translocator-screenshots"
            className="underline decoration-dotted underline-offset-2 hover:text-primary"
          >
            {t("contributeTLsPage.screenshots.guide")}
          </NavLink>
          .
        </p>
        <p className="text-xs text-muted-foreground">{t("contributeTLsPage.screenshots.tip")}</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SlotPicker
            label={t("contributeTLsPage.screenshots.screenshotA")}
            slot={slotA}
            onPick={(f) => pickFile(f, "a")}
            onClear={() => setSlotA(EMPTY_SLOT)}
            onPasteClick={() => pasteFromClipboardButton("a")}
            disabled={mutation.isPending}
          />
          <SlotPicker
            label={t("contributeTLsPage.screenshots.screenshotB")}
            slot={slotB}
            onPick={(f) => pickFile(f, "b")}
            onClear={() => setSlotB(EMPTY_SLOT)}
            onPasteClick={() => pasteFromClipboardButton("b")}
            disabled={mutation.isPending}
          />
        </div>

        {pasteHint && (
          <p className="text-xs text-muted-foreground" role="status">
            {pasteHint}
          </p>
        )}

        <div className="space-y-1">
          <Label htmlFor="tl-screenshot-label">
            {t("contributeTLsPage.screenshots.optionalLabel")}
          </Label>
          <Input
            id="tl-screenshot-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("contributeTLsPage.screenshots.optionalLabelPlaceholder")}
            maxLength={200}
            disabled={mutation.isPending}
          />
        </div>

        {submitError && (
          <div
            className="rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm text-amber-900"
            role="alert"
          >
            {submitError}
          </div>
        )}

        <div className="flex justify-end">
          <Button type="button" disabled={!canSubmit} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            <Upload className="mr-2 size-4" />
            {t("contributeTLsPage.screenshots.submitForReview")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface SlotPickerProps {
  label: string;
  slot: SlotState;
  onPick: (file: File | null) => void;
  onClear: () => void;
  onPasteClick: () => void;
  disabled?: boolean;
}

function SlotPicker({ label, slot, onPick, onClear, onPasteClick, disabled }: SlotPickerProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {slot.previewUrl ? (
        <div className="relative">
          <img
            src={slot.previewUrl}
            alt={t("contributeTLsPage.screenshots.previewAlt", { label })}
            className="w-full max-h-64 object-contain rounded-md border border-border bg-muted"
          />
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            className="absolute top-2 right-2 rounded-full bg-background/80 hover:bg-background border border-border p-1 disabled:opacity-50"
            aria-label={t("contributeTLsPage.screenshots.removeImage")}
          >
            <X className="size-4" />
          </button>
          <p className="mt-1 text-xs text-muted-foreground truncate">
            {slot.file?.name} ({Math.round((slot.file?.size ?? 0) / 1024)} KiB)
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <Input
            type="file"
            accept={ACCEPTED_TYPES.join(",")}
            disabled={disabled}
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={onPasteClick}
            className="w-full"
          >
            <ClipboardPaste className="mr-2 size-4" />
            {t("contributeTLsPage.screenshots.pasteFromClipboard")}
          </Button>
        </div>
      )}
      {slot.error && <p className="text-xs text-destructive">{slot.error}</p>}
    </div>
  );
}

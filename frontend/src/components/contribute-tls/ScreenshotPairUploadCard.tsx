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

import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Upload, X } from "lucide-react";
import {
  ApiError,
  completeTLScreenshotUpload,
  requestTLScreenshotUploadUrls,
  uploadScreenshotToR2,
} from "@/lib/api";

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
  const [slotA, setSlotA] = useState<SlotState>(EMPTY_SLOT);
  const [slotB, setSlotB] = useState<SlotState>(EMPTY_SLOT);
  const [label, setLabel] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  function pickFile(file: File | null, slot: "a" | "b") {
    const setter = slot === "a" ? setSlotA : setSlotB;
    if (file == null) {
      setter(EMPTY_SLOT);
      return;
    }
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setter({
        file: null,
        previewUrl: null,
        error: "Only PNG images are accepted (Vintage Story default screenshot format).",
      });
      return;
    }
    if (file.size > MAX_BYTES) {
      setter({
        file: null,
        previewUrl: null,
        error: `Image too large (${Math.round(file.size / 1024)} KiB > ${MAX_BYTES / 1024} KiB).`,
      });
      return;
    }
    setter({
      file,
      previewUrl: URL.createObjectURL(file),
      error: null,
    });
  }

  const mutation = useMutation({
    mutationFn: async () => {
      if (!slotA.file || !slotB.file) {
        throw new Error("Both screenshots are required.");
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
      queryClient.invalidateQueries({ queryKey: ["my-tl-screenshot-requests"] });
      onSubmitted?.(req.id);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        const detail = err.message;
        if (err.status === 404) {
          setSubmitError("Screenshot contributions are currently disabled by the admin.");
          return;
        }
        if (err.status === 403) {
          setSubmitError("You need an account to submit screenshot contributions.");
          return;
        }
        if (err.status === 429) {
          setSubmitError(
            typeof detail === "string"
              ? detail
              : "You already have too many pending screenshot requests. Wait for the admin to review them.",
          );
          return;
        }
        setSubmitError(typeof detail === "string" ? detail : `HTTP ${err.status}`);
        return;
      }
      setSubmitError(err instanceof Error ? err.message : "Submission failed.");
    },
  });

  const canSubmit = slotA.file != null && slotB.file != null && !mutation.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Submit a translocator pair via screenshots</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Take a screenshot at <strong>each</strong> end of the translocator. The screenshot must
          clearly show the <strong>in-game minimap</strong> (top-right corner) and the{" "}
          <strong>coordinate readout</strong> (default: bottom of the HUD, e.g.{" "}
          <code>X=1234 Y=110 Z=-5678</code>). We use OCR to read the coordinates and compare the
          minimap against the server map to verify authenticity. An admin reviews every submission
          before it's added to the live map. Need examples? Read the{" "}
          <NavLink
            to="/blog/submitting-translocator-screenshots"
            className="underline decoration-dotted underline-offset-2 hover:text-primary"
          >
            Screenshot submission guide
          </NavLink>
          .
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SlotPicker
            label="Screenshot A (first endpoint)"
            slot={slotA}
            onPick={(f) => pickFile(f, "a")}
            onClear={() => setSlotA(EMPTY_SLOT)}
            disabled={mutation.isPending}
          />
          <SlotPicker
            label="Screenshot B (second endpoint)"
            slot={slotB}
            onPick={(f) => pickFile(f, "b")}
            onClear={() => setSlotB(EMPTY_SLOT)}
            disabled={mutation.isPending}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="tl-screenshot-label">Optional label</Label>
          <Input
            id="tl-screenshot-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Spawn -> NE outpost"
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
            Submit for review
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
  disabled?: boolean;
}

function SlotPicker({ label, slot, onPick, onClear, disabled }: SlotPickerProps) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {slot.previewUrl ? (
        <div className="relative">
          <img
            src={slot.previewUrl}
            alt={`${label} preview`}
            className="w-full max-h-64 object-contain rounded-md border border-border bg-muted"
          />
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            className="absolute top-2 right-2 rounded-full bg-background/80 hover:bg-background border border-border p-1 disabled:opacity-50"
            aria-label="Remove image"
          >
            <X className="size-4" />
          </button>
          <p className="mt-1 text-xs text-muted-foreground truncate">
            {slot.file?.name} ({Math.round((slot.file?.size ?? 0) / 1024)} KiB)
          </p>
        </div>
      ) : (
        <Input
          type="file"
          accept={ACCEPTED_TYPES.join(",")}
          disabled={disabled}
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        />
      )}
      {slot.error && <p className="text-xs text-destructive">{slot.error}</p>}
    </div>
  );
}

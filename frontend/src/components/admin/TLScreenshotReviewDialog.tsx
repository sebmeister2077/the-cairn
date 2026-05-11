/**
 * Admin review dialog for a single screenshot-based TL contribution.
 *
 * Shows the two raw screenshots side-by-side along with the auto-detected
 * minimap crops, OCR'd coordinates (editable), validation warnings, and
 * approve/reject actions.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import {
  approveAdminTLScreenshotRequest,
  getAdminTLScreenshotRequest,
  patchAdminTLScreenshotRequest,
  rejectAdminTLScreenshotRequest,
} from "@/lib/api";
import type { TLScreenshotRequest } from "@/models/tlScreenshots";

interface Props {
  requestId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TLScreenshotReviewDialog({ requestId, open, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["admin-tl-screenshot", requestId],
    queryFn: () => getAdminTLScreenshotRequest(requestId!),
    enabled: open && requestId != null,
    refetchInterval: (q) => {
      const r = q.state.data;
      if (!r) return 4000;
      return r.analysis_status === "queued" || r.analysis_status === "running" ? 4000 : false;
    },
  });

  const [coordsA, setCoordsA] = useState<{ x: string; z: string }>({ x: "", z: "" });
  const [coordsB, setCoordsB] = useState<{ x: string; z: string }>({ x: "", z: "" });
  const [label, setLabel] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const r = detail.data;
    if (!r) return;
    setCoordsA({
      x: r.coords_a?.x?.toString() ?? "",
      z: r.coords_a?.z?.toString() ?? "",
    });
    setCoordsB({
      x: r.coords_b?.x?.toString() ?? "",
      z: r.coords_b?.z?.toString() ?? "",
    });
    setLabel(r.label ?? "");
    setActionError(null);
    // Reset only when the dialog opens for a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data?.id]);

  function parseInt32(v: string): number | null {
    if (!v.trim()) return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : NaN;
  }

  const patch = useMutation({
    mutationFn: async () => {
      if (!requestId) throw new Error("no request id");
      const ax = parseInt32(coordsA.x);
      const az = parseInt32(coordsA.z);
      const bx = parseInt32(coordsB.x);
      const bz = parseInt32(coordsB.z);
      if ([ax, az, bx, bz].some((v) => Number.isNaN(v))) {
        throw new Error("Coordinates must be integers.");
      }
      return await patchAdminTLScreenshotRequest(requestId, {
        coords_a: {
          x: ax as number | null,
          z: az as number | null,
          y: detail.data?.coords_a?.y ?? null,
        },
        coords_b: {
          x: bx as number | null,
          z: bz as number | null,
          y: detail.data?.coords_b?.y ?? null,
        },
        label: label.trim() || null,
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["admin-tl-screenshot", requestId], updated);
      queryClient.invalidateQueries({ queryKey: ["admin-tl-screenshots"] });
    },
    onError: (e: unknown) => setActionError(e instanceof Error ? e.message : "Save failed"),
  });

  const approve = useMutation({
    mutationFn: async () => {
      if (!requestId) throw new Error("no request id");
      // Persist any pending edits first so approval uses fresh values.
      if (patch.isPending || hasPendingEdits(detail.data, coordsA, coordsB, label)) {
        await patch.mutateAsync();
      }
      return await approveAdminTLScreenshotRequest(requestId, label.trim() || null);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-tl-screenshots"] });
      queryClient.invalidateQueries({ queryKey: ["translocators-overlay"] });
      onOpenChange(false);
    },
    onError: (e: unknown) => setActionError(e instanceof Error ? e.message : "Approve failed"),
  });

  const reject = useMutation({
    mutationFn: async () => {
      if (!requestId) throw new Error("no request id");
      if (!rejectReason.trim()) throw new Error("Reason is required.");
      return await rejectAdminTLScreenshotRequest(requestId, rejectReason.trim());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-tl-screenshots"] });
      onOpenChange(false);
    },
    onError: (e: unknown) => setActionError(e instanceof Error ? e.message : "Reject failed"),
  });

  const r = detail.data;
  const busy = patch.isPending || approve.isPending || reject.isPending;
  const isPending = r?.status === "pending";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl! lg:max-w-6xl! w-[min(96vw,80rem)]">
        <DialogHeader>
          <DialogTitle>Review screenshot submission</DialogTitle>
        </DialogHeader>
        {detail.isLoading || !r ? (
          <div className="py-10 text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="text-xs text-muted-foreground space-y-0.5">
              <div>
                Submitted by <strong>{r.submitter_display_name ?? "?"}</strong> on{" "}
                {new Date(r.created_at).toLocaleString()}
              </div>
              <div>
                Status: {r.status} · Analysis: {r.analysis_status}
              </div>
              {r.analysis_error && (
                <div className="text-destructive">Analysis error: {r.analysis_error}</div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <SlotPanel
                heading="Screenshot A"
                screenshotUrl={r.screenshot_a_url}
                minimapUrl={r.minimap_a_url}
                ocrText={r.ocr_a?.raw_text}
                ocrConfidence={r.ocr_a?.confidence}
                minimapMatch={r.minimap_match?.a}
                coordX={coordsA.x}
                coordZ={coordsA.z}
                onCoordX={(v) => setCoordsA((p) => ({ ...p, x: v }))}
                onCoordZ={(v) => setCoordsA((p) => ({ ...p, z: v }))}
                editable={isPending}
              />
              <SlotPanel
                heading="Screenshot B"
                screenshotUrl={r.screenshot_b_url}
                minimapUrl={r.minimap_b_url}
                ocrText={r.ocr_b?.raw_text}
                ocrConfidence={r.ocr_b?.confidence}
                minimapMatch={r.minimap_match?.b}
                coordX={coordsB.x}
                coordZ={coordsB.z}
                onCoordX={(v) => setCoordsB((p) => ({ ...p, x: v }))}
                onCoordZ={(v) => setCoordsB((p) => ({ ...p, z: v }))}
                editable={isPending}
              />
            </div>

            {r.validation_warnings.length > 0 && (
              <div className="rounded-md border border-amber-500/50 bg-amber-50 p-3 text-xs space-y-0.5">
                <div className="font-medium text-amber-900">Validation warnings</div>
                <ul className="space-y-0.5">
                  {r.validation_warnings.map((w, i) => (
                    <li
                      key={i}
                      className={
                        w.severity === "error"
                          ? "text-destructive"
                          : w.severity === "warning"
                            ? "text-amber-700"
                            : "text-muted-foreground"
                      }
                    >
                      • [{w.code}] {w.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-1">
              <Label htmlFor="tl-screenshot-label-admin">Label</Label>
              <Input
                id="tl-screenshot-label-admin"
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                disabled={!isPending || busy}
                maxLength={200}
              />
            </div>

            {actionError && (
              <div
                className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive"
                role="alert"
              >
                {actionError}
              </div>
            )}

            {isPending && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => patch.mutate()}
                  disabled={busy}
                >
                  {patch.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Save edits
                </Button>
                <Button type="button" onClick={() => approve.mutate()} disabled={busy}>
                  {approve.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Approve & merge
                </Button>
                <div className="ml-auto flex items-center gap-2">
                  <Input
                    type="text"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Reject reason"
                    className="w-64"
                    disabled={busy}
                  />
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => reject.mutate()}
                    disabled={busy || !rejectReason.trim()}
                  >
                    {reject.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                    Reject
                  </Button>
                </div>
              </div>
            )}

            {r.status === "approved" && r.resulting_segment_id && (
              <div className="text-xs text-emerald-700">
                Approved. Segment id: <code>{r.resulting_segment_id}</code>
              </div>
            )}
            {r.status === "rejected" && (
              <div className="text-xs text-destructive">Rejected: {r.decision_reason}</div>
            )}
            {r.status === "withdrawn" && (
              <div className="text-xs text-muted-foreground">Withdrawn by submitter.</div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function hasPendingEdits(
  r: TLScreenshotRequest | undefined,
  coordsA: { x: string; z: string },
  coordsB: { x: string; z: string },
  label: string,
): boolean {
  if (!r) return false;
  const eq = (a: number | null | undefined, b: string) => (a ?? "").toString() === b.trim();
  return !(
    eq(r.coords_a?.x, coordsA.x) &&
    eq(r.coords_a?.z, coordsA.z) &&
    eq(r.coords_b?.x, coordsB.x) &&
    eq(r.coords_b?.z, coordsB.z) &&
    (r.label ?? "") === label.trim()
  );
}

interface SlotProps {
  heading: string;
  screenshotUrl: string | null | undefined;
  minimapUrl: string | null | undefined;
  ocrText: string | undefined;
  ocrConfidence: number | undefined;
  minimapMatch: { score: number; method: string; chunks_used: number } | undefined;
  coordX: string;
  coordZ: string;
  onCoordX: (v: string) => void;
  onCoordZ: (v: string) => void;
  editable: boolean;
}

function SlotPanel({
  heading,
  screenshotUrl,
  minimapUrl,
  ocrText,
  ocrConfidence,
  minimapMatch,
  coordX,
  coordZ,
  onCoordX,
  onCoordZ,
  editable,
}: SlotProps) {
  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="font-medium text-sm">{heading}</div>
      {screenshotUrl ? (
        <a href={screenshotUrl} target="_blank" rel="noopener noreferrer">
          <img
            src={screenshotUrl}
            alt={heading}
            className="w-full max-h-72 object-contain rounded border border-border bg-muted"
          />
        </a>
      ) : (
        <div className="text-xs text-muted-foreground">Screenshot unavailable.</div>
      )}
      {minimapUrl && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Auto-detected minimap crop
          </div>
          <img
            src={minimapUrl}
            alt={`${heading} minimap`}
            className="max-h-32 object-contain rounded border border-border bg-muted"
          />
        </div>
      )}
      {ocrText && (
        <div className="text-xs">
          <div className="text-muted-foreground">
            OCR (conf {ocrConfidence?.toFixed(2) ?? "?"}):
          </div>
          <code className="break-all">{ocrText}</code>
        </div>
      )}
      {minimapMatch && (
        <div className="text-xs text-muted-foreground">
          Minimap match: <strong>{minimapMatch.score.toFixed(3)}</strong> ({minimapMatch.method},{" "}
          {minimapMatch.chunks_used} chunks)
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-[10px]">X</Label>
          <Input
            type="number"
            value={coordX}
            onChange={(e) => onCoordX(e.target.value)}
            disabled={!editable}
          />
        </div>
        <div>
          <Label className="text-[10px]">Z</Label>
          <Input
            type="number"
            value={coordZ}
            onChange={(e) => onCoordZ(e.target.value)}
            disabled={!editable}
          />
        </div>
      </div>
    </div>
  );
}

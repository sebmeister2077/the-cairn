import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  adminApproveLandmarkEditRequest,
  adminRejectLandmarkEditRequest,
  type LandmarkEditRequest,
} from "@/lib/api";
import { useMutation } from "@tanstack/react-query";
import { Loader2, X, Check } from "lucide-react";
import { useState } from "react";

export function LandmarkPendingEditRequestRow({
  request,
  onChanged,
}: {
  request: LandmarkEditRequest;
  onChanged: () => void;
}) {
  const [note, setNote] = useState("");

  const approveMut = useMutation({
    mutationFn: () => adminApproveLandmarkEditRequest(request.id, note || undefined),
    onSuccess: onChanged,
  });
  const rejectMut = useMutation({
    mutationFn: () => adminRejectLandmarkEditRequest(request.id, note || undefined),
    onSuccess: onChanged,
  });

  const busy = approveMut.isPending || rejectMut.isPending;
  const err = approveMut.error ?? rejectMut.error;

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5 min-w-0">
          <div className="text-sm">
            <span className="text-muted-foreground">By </span>
            <span className="font-medium">{request.submitted_by_display_name}</span>
            <span className="text-muted-foreground"> · {formatTimestamp(request.created_at)}</span>
          </div>
          <div className="text-xs text-muted-foreground font-mono break-all">
            landmark {request.landmark_id}
          </div>
        </div>
      </div>
      <div className="text-sm grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="rounded bg-muted/40 p-2">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Current</div>
          <div className="whitespace-pre-wrap wrap-break-word">
            {request.current_label || <em>(empty)</em>}
          </div>
        </div>
        <div className="rounded bg-muted/40 p-2">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Proposed</div>
          <div className="whitespace-pre-wrap wrap-break-word">{request.proposed_label}</div>
        </div>
      </div>
      <Input
        placeholder="Optional review note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={busy}
      />
      {err && <p className="text-xs text-destructive">{(err as Error).message}</p>}
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="outline" onClick={() => rejectMut.mutate()} disabled={busy}>
          {rejectMut.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <X className="size-3" />
          )}
          <span className="ml-1">Reject</span>
        </Button>
        <Button size="sm" onClick={() => approveMut.mutate()} disabled={busy}>
          {approveMut.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Check className="size-3" />
          )}
          <span className="ml-1">Approve</span>
        </Button>
      </div>
    </div>
  );
}

function formatTimestamp(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

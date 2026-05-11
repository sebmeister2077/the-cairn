/**
 * Lists the current user's pending and historical screenshot-based TL
 * contribution requests.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Trash2 } from "lucide-react";
import { listMyTLScreenshotRequests, withdrawTLScreenshotRequest } from "@/lib/api";
import type { TLScreenshotRequest } from "@/models/tlScreenshots";

const QUERY_KEY = ["my-tl-screenshot-requests"] as const;

export function MyScreenshotRequestsList() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listMyTLScreenshotRequests,
    refetchInterval: (q) => {
      // Poll while any request is still being analysed.
      const items = q.state.data?.items ?? [];
      return items.some((r) => r.analysis_status === "queued" || r.analysis_status === "running")
        ? 5000
        : false;
    },
  });

  const withdraw = useMutation({
    mutationFn: (id: string) => withdrawTLScreenshotRequest(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  if (query.isLoading) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" />
          Loading your submissions…
        </CardContent>
      </Card>
    );
  }
  if (query.isError) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-destructive">
          Failed to load your submissions.
        </CardContent>
      </Card>
    );
  }

  const items = query.data?.items ?? [];
  if (items.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Your screenshot submissions</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          You haven&rsquo;t submitted any screenshot pairs yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your screenshot submissions ({items.length})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((r) => (
          <RequestRow
            key={r.id}
            request={r}
            onWithdraw={() => withdraw.mutate(r.id)}
            withdrawing={withdraw.isPending && withdraw.variables === r.id}
          />
        ))}
      </CardContent>
    </Card>
  );
}

interface RowProps {
  request: TLScreenshotRequest;
  onWithdraw: () => void;
  withdrawing: boolean;
}

function RequestRow({ request, onWithdraw, withdrawing }: RowProps) {
  const a = request.coords_a;
  const b = request.coords_b;
  return (
    <div className="rounded-md border border-border p-3 text-sm space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusPill status={request.status} />
          {request.status === "pending" && <AnalysisPill status={request.analysis_status} />}
        </div>
        {request.status === "pending" && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onWithdraw}
            disabled={withdrawing}
          >
            {withdrawing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Trash2 className="size-3" />
            )}
            <span className="ml-1">Withdraw</span>
          </Button>
        )}
      </div>
      {request.label && <div className="text-muted-foreground">Label: {request.label}</div>}
      <div className="font-mono text-xs">
        A: {fmtCoord(a)} &nbsp;→&nbsp; B: {fmtCoord(b)}
      </div>
      {request.validation_warnings.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {request.validation_warnings.map((w, i) => (
            <li
              key={i}
              className={`text-xs ${
                w.severity === "error"
                  ? "text-destructive"
                  : w.severity === "warning"
                    ? "text-amber-700"
                    : "text-muted-foreground"
              }`}
            >
              • {w.message}
            </li>
          ))}
        </ul>
      )}
      {request.status === "rejected" && request.decision_reason && (
        <div className="text-xs text-destructive">Rejected: {request.decision_reason}</div>
      )}
      {request.analysis_status === "failed" && request.analysis_error && (
        <div className="text-xs text-destructive">Analysis failed: {request.analysis_error}</div>
      )}
      <div className="text-xs text-muted-foreground">
        Submitted {new Date(request.created_at).toLocaleString()}
      </div>
    </div>
  );
}

function fmtCoord(c: TLScreenshotRequest["coords_a"]): string {
  if (!c) return "—";
  const x = c.x ?? "?";
  const z = c.z ?? "?";
  return `(${x}, ${z})`;
}

function StatusPill({ status }: { status: TLScreenshotRequest["status"] }) {
  const cls =
    status === "approved"
      ? "bg-emerald-100 text-emerald-800"
      : status === "rejected"
        ? "bg-rose-100 text-rose-800"
        : status === "withdrawn"
          ? "bg-slate-100 text-slate-700"
          : "bg-blue-100 text-blue-800";
  return (
    <span className={`text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 ${cls}`}>
      {status}
    </span>
  );
}

function AnalysisPill({ status }: { status: TLScreenshotRequest["analysis_status"] }) {
  if (status === "done") return null;
  const labels: Record<string, string> = {
    queued: "queued",
    running: "analysing",
    failed: "analysis failed",
  };
  const cls = status === "failed" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700";
  return (
    <span className={`text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 ${cls}`}>
      {labels[status] ?? status}
    </span>
  );
}

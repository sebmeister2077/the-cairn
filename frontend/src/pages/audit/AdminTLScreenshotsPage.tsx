/**
 * Admin page: list & review screenshot-based TL contributions.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { listAdminTLScreenshotRequests } from "@/lib/api";
import type { TLScreenshotRequest } from "@/models/tlScreenshots";
import { TLScreenshotReviewDialog } from "@/components/admin/TLScreenshotReviewDialog";

const PAGE_SIZE = 25;
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "withdrawn", label: "Withdrawn" },
  { value: "", label: "All" },
];

export function AdminTLScreenshotsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["admin-tl-screenshots", statusFilter, offset],
    queryFn: () =>
      listAdminTLScreenshotRequests({
        status: statusFilter || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
    refetchInterval: (q) => {
      const items = q.state.data?.items ?? [];
      return items.some((r) => r.analysis_status === "queued" || r.analysis_status === "running")
        ? 5000
        : 30000;
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Translocator screenshot submissions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Status:</span>
            {STATUS_OPTIONS.map((opt) => (
              <Button
                key={opt.value}
                type="button"
                size="sm"
                variant={statusFilter === opt.value ? "default" : "outline"}
                onClick={() => {
                  setStatusFilter(opt.value);
                  setOffset(0);
                }}
              >
                {opt.label}
              </Button>
            ))}
            <span className="ml-auto text-xs text-muted-foreground">
              {query.data?.total ?? 0} total
            </span>
          </div>

          {query.isLoading ? (
            <div className="py-6 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </div>
          ) : query.isError ? (
            <div className="py-6 text-sm text-destructive">Failed to load submissions.</div>
          ) : (query.data?.items.length ?? 0) === 0 ? (
            <div className="py-6 text-sm text-muted-foreground">No submissions in this view.</div>
          ) : (
            <div className="divide-y divide-border rounded border border-border">
              {query.data!.items.map((r) => (
                <RequestRow key={r.id} request={r} onOpen={() => setOpenId(r.id)} />
              ))}
            </div>
          )}

          {query.data && query.data.total > PAGE_SIZE && (
            <div className="flex items-center justify-between pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                disabled={offset === 0}
              >
                Prev
              </Button>
              <span className="text-xs text-muted-foreground">
                {offset + 1}-{Math.min(offset + PAGE_SIZE, query.data.total)} of {query.data.total}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (query.data?.next_offset != null) setOffset(query.data.next_offset);
                }}
                disabled={query.data?.next_offset == null}
              >
                Next
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <TLScreenshotReviewDialog
        open={openId != null}
        requestId={openId}
        onOpenChange={(open) => {
          if (!open) setOpenId(null);
        }}
      />
    </div>
  );
}

interface RowProps {
  request: TLScreenshotRequest;
  onOpen: () => void;
}

function RequestRow({ request, onOpen }: RowProps) {
  const a = request.coords_a;
  const b = request.coords_b;
  const warningCount = request.validation_warnings.length;
  return (
    <div className="flex items-center justify-between gap-3 p-3 text-sm hover:bg-muted/30">
      <div className="space-y-0.5 min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{request.submitter_display_name ?? "?"}</span>
          {request.label && (
            <span className="text-xs text-muted-foreground truncate">· {request.label}</span>
          )}
        </div>
        <div className="font-mono text-xs text-muted-foreground">
          A {fmt(a)} → B {fmt(b)}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {new Date(request.created_at).toLocaleString()} · analysis {request.analysis_status}
          {warningCount > 0 && (
            <span className="ml-2 text-amber-700">
              {warningCount} warning{warningCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={onOpen}>
        Review
      </Button>
    </div>
  );
}

function fmt(c: TLScreenshotRequest["coords_a"]): string {
  if (!c) return "—";
  return `(${c.x ?? "?"}, ${c.z ?? "?"})`;
}

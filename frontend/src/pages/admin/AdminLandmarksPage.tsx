/**
 * Admin: Landmarks (route: /manage/landmarks).
 *
 * Three panels stacked vertically:
 *   1. Pending rename-requests queue — approve / reject each.
 *   2. Recent audit feed (latest 100 mutations).
 *   3. Geojson backups — list, create-now per asset, restore.
 *
 * All endpoints require the env-var admin API key (and pass through the
 * WebAuthn-session gate when one is configured).
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, RotateCcw, Trash2, X } from "lucide-react";

import {
  adminApproveLandmarkEditRequest,
  adminCreateGeojsonBackup,
  adminDeleteLandmark,
  adminListGeojsonBackups,
  adminListLandmarkAudit,
  adminListLandmarkEditRequests,
  adminRejectLandmarkEditRequest,
  adminRestoreGeojsonBackup,
  type GeojsonBackupEntry,
  type LandmarkAuditEntry,
  type LandmarkEditRequest,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatTimestamp(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

export function AdminLandmarksPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Landmarks</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Review user-submitted landmark renames, inspect the audit log, and manage the
          landmarks/translocators backups.
        </p>
      </div>

      <PendingEditRequestsCard />
      <AuditFeedCard />
      <BackupsCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending rename requests
// ---------------------------------------------------------------------------

function PendingEditRequestsCard() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-landmark-edit-requests", "pending"],
    queryFn: () => adminListLandmarkEditRequests("pending"),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-landmark-edit-requests"] });
    queryClient.invalidateQueries({ queryKey: ["admin-landmark-audit"] });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>Pending rename requests</span>
          {data && <Badge variant="secondary">{data.edit_requests.length}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {data && data.edit_requests.length === 0 && (
          <p className="text-sm text-muted-foreground">No pending requests.</p>
        )}
        {data?.edit_requests.map((req) => (
          <PendingEditRequestRow key={req.id} request={req} onChanged={invalidate} />
        ))}
      </CardContent>
    </Card>
  );
}

function PendingEditRequestRow({
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

// ---------------------------------------------------------------------------
// Audit feed
// ---------------------------------------------------------------------------

function AuditFeedCard() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-landmark-audit"],
    queryFn: () => adminListLandmarkAudit({ limit: 100 }),
  });

  const deleteMut = useMutation({
    mutationFn: (landmarkId: string) => adminDeleteLandmark(landmarkId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-landmark-audit"] });
      queryClient.invalidateQueries({ queryKey: ["admin-landmark-edit-requests"] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent audit (latest 100)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {data && data.audit.length === 0 && (
          <p className="text-sm text-muted-foreground">No audit entries yet.</p>
        )}
        {deleteMut.error && (
          <p className="text-xs text-destructive">{(deleteMut.error as Error).message}</p>
        )}
        <div className="divide-y border rounded-md">
          {data?.audit.map((row) => (
            <AuditRow
              key={row.id}
              row={row}
              onDelete={() => {
                if (window.confirm(`Hard-delete landmark ${row.landmark_id}?`)) {
                  deleteMut.mutate(row.landmark_id);
                }
              }}
              deleting={deleteMut.isPending && deleteMut.variables === row.landmark_id}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function AuditRow({
  row,
  onDelete,
  deleting,
}: {
  row: LandmarkAuditEntry;
  onDelete: () => void;
  deleting: boolean;
}) {
  const showDelete = row.action !== "admin_delete" && !row.landmark_id.startsWith("<");
  return (
    <div className="px-3 py-2 text-xs flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="font-mono">
            {row.action}
          </Badge>
          <span className="text-muted-foreground">{formatTimestamp(row.created_at)}</span>
          {row.actor_display_name && (
            <span>
              by <span className="font-medium">{row.actor_display_name}</span>
            </span>
          )}
        </div>
        <div className="font-mono text-muted-foreground break-all">{row.landmark_id}</div>
      </div>
      {showDelete && (
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
          disabled={deleting}
          title="Hard-delete this landmark"
        >
          {deleting ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

function BackupsCard() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-landmark-backups"],
    queryFn: adminListGeojsonBackups,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-landmark-backups"] });
  };

  const createMut = useMutation({
    mutationFn: (asset: "landmarks" | "translocators") => adminCreateGeojsonBackup(asset),
    onSuccess: invalidate,
  });

  const restoreMut = useMutation({
    mutationFn: ({ asset, key }: { asset: "landmarks" | "translocators"; key: string }) =>
      adminRestoreGeojsonBackup(asset, key),
    onSuccess: invalidate,
  });

  const grouped = useMemo(() => {
    const out = {
      landmarks: [] as GeojsonBackupEntry[],
      translocators: [] as GeojsonBackupEntry[],
    };
    for (const b of data?.backups ?? []) out[b.asset].push(b);
    return out;
  }, [data]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Geojson backups</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {(["landmarks", "translocators"] as const).map((asset) => (
          <div key={asset} className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold capitalize">{asset}</h3>
              <Button
                size="sm"
                variant="outline"
                onClick={() => createMut.mutate(asset)}
                disabled={createMut.isPending}
              >
                {createMut.isPending && createMut.variables === asset ? (
                  <Loader2 className="size-3 animate-spin mr-1" />
                ) : null}
                Snapshot now
              </Button>
            </div>
            {createMut.error && createMut.variables === asset && (
              <p className="text-xs text-destructive">{(createMut.error as Error).message}</p>
            )}
            {grouped[asset].length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No backups yet.</p>
            ) : (
              <div className="border rounded-md divide-y">
                {grouped[asset].map((b) => (
                  <div
                    key={b.key}
                    className="px-3 py-2 text-xs flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="font-mono break-all">{b.key.replace(/^backups\//, "")}</div>
                      <div className="text-muted-foreground">
                        <Badge variant="outline" className="mr-1">
                          {b.kind}
                        </Badge>
                        {formatBytes(b.size)} · {formatTimestamp(b.last_modified)}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Restore ${asset} from ${b.key}? This overwrites the live file.`,
                          )
                        ) {
                          restoreMut.mutate({ asset, key: b.key });
                        }
                      }}
                      disabled={restoreMut.isPending}
                      title="Restore this snapshot over the live file"
                    >
                      {restoreMut.isPending && restoreMut.variables?.key === b.key ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3" />
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {restoreMut.error && (
          <p className="text-xs text-destructive">{(restoreMut.error as Error).message}</p>
        )}
      </CardContent>
    </Card>
  );
}

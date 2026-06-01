/**
 * Admin: Elk-walkable edges (route: /manage/elk-walkable).
 *
 * Two stacked cards:
 *   1. Recent audit feed — per-row revert for attest / unattest entries.
 *   2. Snapshot list — per-row restore (full-file rollback to a
 *      previously-snapshotted version).
 *
 * Both views require the env-var admin API key.
 */

import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adminListElkWalkableAudit,
  adminListElkWalkableSnapshots,
  adminRestoreElkWalkableSnapshot,
  adminRevertElkWalkableAudit,
  type AdminElkWalkableAuditEntry,
} from "@/lib/api";
import { ELK_WALKABLE_QUERY_KEY } from "@/hooks/useElkWalkable";
import { formatTimestamp } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ChevronLeft, ChevronRight, Loader2, RotateCcw, Undo2 } from "lucide-react";

const AUDIT_KEY = ["admin-elk-walkable-audit"] as const;
const SNAPSHOTS_KEY = ["admin-elk-walkable-snapshots"] as const;
const AUDIT_PAGE_SIZE = 25;
const SNAPSHOT_LIMIT = 200;

const REVERTIBLE_ACTIONS = new Set(["attest", "unattest"]);

function actionBadgeVariant(action: string): "default" | "secondary" | "destructive" | "outline" {
  if (action === "attest") return "secondary";
  if (action === "unattest") return "destructive";
  if (action.startsWith("admin_")) return "outline";
  return "default";
}

export function AdminElkWalkablePage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Elk-walkable edges</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          User attestations marking walkable areas between non-connected translocators as
          elk-friendly. Revert single audit rows or roll back the entire file from a snapshot.
        </p>
      </div>

      <ElkAuditCard />
      <ElkSnapshotsCard />
    </div>
  );
}

function ElkAuditCard() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [revertTarget, setRevertTarget] = useState<AdminElkWalkableAuditEntry | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: [...AUDIT_KEY, page],
    queryFn: () =>
      adminListElkWalkableAudit({
        limit: AUDIT_PAGE_SIZE,
        offset: page * AUDIT_PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  const revertMut = useMutation({
    mutationFn: (auditId: number) => adminRevertElkWalkableAudit(auditId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AUDIT_KEY });
      queryClient.invalidateQueries({ queryKey: SNAPSHOTS_KEY });
      queryClient.invalidateQueries({ queryKey: ELK_WALKABLE_QUERY_KEY });
      setRevertTarget(null);
    },
  });

  const rows = data?.audit ?? [];
  const hasNext = rows.length === AUDIT_PAGE_SIZE;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Recent audit</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {data && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No audit entries yet.</p>
        )}
        <div className="divide-y border rounded-md">
          {rows.map((row) => (
            <ElkAuditRow
              key={row.id}
              row={row}
              onRevert={() => setRevertTarget(row)}
              reverting={revertMut.isPending && revertTarget?.id === row.id}
            />
          ))}
        </div>
        {revertMut.error && (
          <p className="text-sm text-destructive">
            Revert failed: {(revertMut.error as Error).message}
          </p>
        )}
        <SimplePager
          page={page}
          onPageChange={setPage}
          hasNext={hasNext}
          rangeLabel={`${rows.length} on this page`}
        />
      </CardContent>

      <ConfirmDialog
        open={revertTarget != null}
        title="Revert audit row?"
        description={
          revertTarget ? (
            <div className="space-y-1 text-sm">
              <div>
                Inverts{" "}
                <Badge variant={actionBadgeVariant(revertTarget.action)}>
                  {revertTarget.action}
                </Badge>{" "}
                on edge <code className="break-all text-xs">{revertTarget.edge_key ?? "—"}</code>.
              </div>
              <div className="text-muted-foreground text-xs">
                A pre-revert snapshot is written first, and the revert itself is recorded as a new
                admin_revert audit row.
              </div>
            </div>
          ) : null
        }
        confirmLabel="Revert"
        variant="destructive"
        loading={revertMut.isPending}
        onConfirm={() => revertTarget && revertMut.mutate(revertTarget.id)}
        onCancel={() => {
          if (!revertMut.isPending) setRevertTarget(null);
        }}
      />
    </Card>
  );
}

function ElkAuditRow({
  row,
  onRevert,
  reverting,
}: {
  row: AdminElkWalkableAuditEntry;
  onRevert: () => void;
  reverting: boolean;
}) {
  const revertible = REVERTIBLE_ACTIONS.has(row.action);
  return (
    <div className="min-w-0 space-y-0.5 px-3 py-2 text-xs">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant={actionBadgeVariant(row.action)}>{row.action}</Badge>
        <span className="min-w-0 break-all font-mono text-[11px] text-muted-foreground">
          {row.edge_key ?? "—"}
        </span>
        <span className="text-muted-foreground">by</span>
        <span className="wrap-break-word font-medium">
          {row.actor_display_name || row.actor_api_key_id || "—"}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span className="whitespace-nowrap text-muted-foreground">
            {formatTimestamp(row.created_at)}
          </span>
          {revertible && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onRevert}
              disabled={reverting}
              title="Revert this audit row"
            >
              {reverting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Undo2 className="size-4" />
              )}
            </Button>
          )}
        </span>
      </div>
      <div className="text-[11px] text-muted-foreground">
        id #{row.id}
        {row.snapshot_key && (
          <>
            {" · snapshot "}
            <code className="break-all">{row.snapshot_key}</code>
          </>
        )}
      </div>
    </div>
  );
}

function ElkSnapshotsCard() {
  const queryClient = useQueryClient();
  const [restoreKey, setRestoreKey] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: SNAPSHOTS_KEY,
    queryFn: () => adminListElkWalkableSnapshots(SNAPSHOT_LIMIT),
  });

  const restoreMut = useMutation({
    mutationFn: (key: string) => adminRestoreElkWalkableSnapshot(key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AUDIT_KEY });
      queryClient.invalidateQueries({ queryKey: SNAPSHOTS_KEY });
      queryClient.invalidateQueries({ queryKey: ELK_WALKABLE_QUERY_KEY });
      setRestoreKey(null);
    },
  });

  const snapshots = data?.snapshots ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Snapshots</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {data && snapshots.length === 0 && (
          <p className="text-sm text-muted-foreground">No snapshots yet.</p>
        )}
        <div className="divide-y border rounded-md">
          {snapshots.map((snap) => (
            <div key={snap.key} className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs">
              <code className="min-w-0 flex-1 break-all font-mono text-[11px]">{snap.key}</code>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setRestoreKey(snap.key)}
                disabled={restoreMut.isPending && restoreKey === snap.key}
                title="Restore this snapshot"
              >
                {restoreMut.isPending && restoreKey === snap.key ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RotateCcw className="size-4" />
                )}
              </Button>
            </div>
          ))}
        </div>
        {restoreMut.error && (
          <p className="text-sm text-destructive">
            Restore failed: {(restoreMut.error as Error).message}
          </p>
        )}
      </CardContent>

      <ConfirmDialog
        open={restoreKey != null}
        title="Restore snapshot?"
        description={
          restoreKey ? (
            <div className="space-y-1 text-sm">
              <div>
                Replaces the live elk-walkable file with{" "}
                <code className="break-all text-xs">{restoreKey}</code>.
              </div>
              <div className="text-muted-foreground text-xs">
                A pre-restore snapshot of the current live file is written first, so this operation
                is itself reversible.
              </div>
            </div>
          ) : null
        }
        confirmLabel="Restore"
        variant="destructive"
        loading={restoreMut.isPending}
        onConfirm={() => restoreKey && restoreMut.mutate(restoreKey)}
        onCancel={() => {
          if (!restoreMut.isPending) setRestoreKey(null);
        }}
      />
    </Card>
  );
}

function SimplePager({
  page,
  onPageChange,
  hasNext,
  rangeLabel,
}: {
  page: number;
  onPageChange: (page: number) => void;
  hasNext: boolean;
  rangeLabel: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{rangeLabel}</span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onPageChange(Math.max(0, page - 1))}
          disabled={page <= 0}
          title="Previous page"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span>Page {page + 1}</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onPageChange(page + 1)}
          disabled={!hasNext}
          title="Next page"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

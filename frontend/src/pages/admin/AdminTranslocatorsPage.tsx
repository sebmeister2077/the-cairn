/**
 * Admin: User-contributed Translocators (route: /manage/translocators).
 *
 * Two stacked cards:
 *   1. Live user-contributed translocators — one row per still-present
 *      segment, with contributor / submission stats / coordinates and
 *      single + by-user delete actions.
 *   2. Recent audit feed (latest 100 mutations: add, admin_delete).
 *
 * Both views require the env-var admin API key.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adminDeleteTranslocator,
  adminDeleteTranslocatorsByUser,
  adminListTranslocatorAudit,
  adminListTranslocators,
  type AdminTranslocatorEntry,
  type TranslocatorAuditEntry,
} from "@/lib/api";
import { TRANSLOCATORS_QUERY_KEY } from "@/hooks/useOverlayData";
import { formatTimestamp } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Loader2, Trash2, Users } from "lucide-react";

const ADMIN_TLS_KEY = ["admin-translocators"] as const;
const ADMIN_TLS_AUDIT_KEY = ["admin-translocators-audit"] as const;

function statKey(stats: Record<string, unknown> | null, key: string): string {
  if (!stats) return "—";
  const v = stats[key];
  if (v == null) return "—";
  return String(v);
}

/** Server stores +Z = south; flip to display-style +Z = north so coords match the map UI. */
function fmtCoords(coords: number[][]): string {
  if (!Array.isArray(coords) || coords.length < 2) return "—";
  const [a, b] = coords;
  if (!Array.isArray(a) || !Array.isArray(b)) return "—";
  const fmt = (x: number, z: number) =>
    `(${Math.round(x).toLocaleString()}, ${Math.round(-z).toLocaleString()})`;
  return `${fmt(a[0], a[1])} \u2192 ${fmt(b[0], b[1])}`;
}

export function AdminTranslocatorsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">User-contributed Translocators</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Live submissions, per-batch self-reported stats, and the recent audit feed. Deletes are
          hard but recoverable from the audit log&apos;s before-snapshots.
        </p>
      </div>

      <LiveTranslocatorsCard />
      <TranslocatorAuditCard />
    </div>
  );
}

function LiveTranslocatorsCard() {
  const queryClient = useQueryClient();
  const [singleDeleteId, setSingleDeleteId] = useState<string | null>(null);
  const [bulkDeleteUser, setBulkDeleteUser] = useState<{
    id: string;
    label: string;
    count: number;
  } | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ADMIN_TLS_KEY,
    queryFn: adminListTranslocators,
  });

  // Group by contributor so the "delete all from X" affordance shows an
  // honest count.
  const byUser = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>();
    for (const row of data?.translocators ?? []) {
      if (!row.still_present) continue;
      const id = row.actor_api_key_id ?? "";
      if (!id) continue;
      const existing = m.get(id);
      const label = row.actor_display_name || id;
      if (existing) existing.count += 1;
      else m.set(id, { label, count: 1 });
    }
    return m;
  }, [data]);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ADMIN_TLS_KEY });
    queryClient.invalidateQueries({ queryKey: ADMIN_TLS_AUDIT_KEY });
    // Also refresh the live geojson so the TOPS map updates immediately.
    queryClient.invalidateQueries({ queryKey: TRANSLOCATORS_QUERY_KEY });
  };

  const singleDeleteMut = useMutation({
    mutationFn: (segmentId: string) => adminDeleteTranslocator(segmentId),
    onSuccess: invalidateAll,
  });
  const bulkDeleteMut = useMutation({
    mutationFn: (userId: string) => adminDeleteTranslocatorsByUser(userId),
    onSuccess: invalidateAll,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Live submissions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {data && data.translocators.length === 0 && (
          <p className="text-sm text-muted-foreground">No user-contributed translocators yet.</p>
        )}
        {(singleDeleteMut.error || bulkDeleteMut.error) && (
          <p className="text-xs text-destructive">
            {((singleDeleteMut.error || bulkDeleteMut.error) as Error).message}
          </p>
        )}
        {data && data.translocators.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="text-left border-b">
                  <th className="py-1.5 pr-3 font-medium">Submitted</th>
                  <th className="py-1.5 pr-3 font-medium">Contributor</th>
                  <th className="py-1.5 pr-3 font-medium">Coordinates</th>
                  <th className="py-1.5 pr-3 font-medium">Label</th>
                  <th
                    className="py-1.5 pr-3 font-medium"
                    title="Self-reported existing-pair match %"
                  >
                    Match %
                  </th>
                  <th
                    className="py-1.5 pr-3 font-medium"
                    title="Self-reported existing pairs they have"
                  >
                    Existing pairs
                  </th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.translocators.map((row) => (
                  <TranslocatorRow
                    key={row.segment_id}
                    row={row}
                    bulkInfo={
                      row.actor_api_key_id ? (byUser.get(row.actor_api_key_id) ?? null) : null
                    }
                    deleting={
                      singleDeleteMut.isPending && singleDeleteMut.variables === row.segment_id
                    }
                    onDelete={() => setSingleDeleteId(row.segment_id)}
                    onBulkDelete={() => {
                      if (!row.actor_api_key_id) return;
                      const info = byUser.get(row.actor_api_key_id);
                      if (!info) return;
                      setBulkDeleteUser({
                        id: row.actor_api_key_id,
                        label: info.label,
                        count: info.count,
                      });
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ConfirmDialog
          title="Delete translocator"
          description={`Hard-delete segment ${singleDeleteId}? Recoverable from the audit log.`}
          open={singleDeleteId !== null}
          onCancel={() => setSingleDeleteId(null)}
          onConfirm={() => {
            if (singleDeleteId) {
              singleDeleteMut.mutate(singleDeleteId);
              setSingleDeleteId(null);
            }
          }}
          confirmLabel="Delete"
          variant="destructive"
        />
        <ConfirmDialog
          title="Delete all translocators from this user"
          description={
            bulkDeleteUser
              ? `Hard-delete all ${bulkDeleteUser.count} live segment(s) contributed by ${bulkDeleteUser.label}? Each is captured in the audit log.`
              : ""
          }
          open={bulkDeleteUser !== null}
          onCancel={() => setBulkDeleteUser(null)}
          onConfirm={() => {
            if (bulkDeleteUser) {
              bulkDeleteMut.mutate(bulkDeleteUser.id);
              setBulkDeleteUser(null);
            }
          }}
          confirmLabel="Delete all"
          variant="destructive"
        />
      </CardContent>
    </Card>
  );
}

function TranslocatorRow({
  row,
  bulkInfo,
  deleting,
  onDelete,
  onBulkDelete,
}: {
  row: AdminTranslocatorEntry;
  bulkInfo: { label: string; count: number } | null;
  deleting: boolean;
  onDelete: () => void;
  onBulkDelete: () => void;
}) {
  return (
    <tr className="border-b last:border-b-0 hover:bg-muted/40">
      <td className="py-1.5 pr-3 whitespace-nowrap">{formatTimestamp(row.created_at)}</td>
      <td className="py-1.5 pr-3">
        <div className="font-medium">{row.actor_display_name || "—"}</div>
        {row.actor_api_key_id && (
          <div className="text-muted-foreground text-[10px]">{row.actor_api_key_id}</div>
        )}
      </td>
      <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{fmtCoords(row.coordinates)}</td>
      <td className="py-1.5 pr-3">{row.label || "—"}</td>
      <td className="py-1.5 pr-3 whitespace-nowrap">
        {statKey(row.submission_stats, "existing_match_pct")}
      </td>
      <td className="py-1.5 pr-3 whitespace-nowrap">
        {statKey(row.submission_stats, "existing_pair_count")}
      </td>
      <td className="py-1.5 pr-3">
        {row.still_present ? (
          <Badge variant="secondary">live</Badge>
        ) : (
          <Badge variant="outline">deleted</Badge>
        )}
      </td>
      <td className="py-1.5 pr-3">
        <div className="flex justify-end gap-1">
          {row.still_present && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onDelete}
              disabled={deleting}
              title="Delete this segment"
            >
              {deleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
            </Button>
          )}
          {bulkInfo && bulkInfo.count > 1 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onBulkDelete}
              title={`Delete all ${bulkInfo.count} from ${bulkInfo.label}`}
            >
              <Users className="size-4" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function TranslocatorAuditCard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ADMIN_TLS_AUDIT_KEY,
    queryFn: () => adminListTranslocatorAudit({ limit: 100 }),
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
        <div className="divide-y border rounded-md">
          {data?.audit.map((row) => (
            <AuditRow key={row.id} row={row} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function AuditRow({ row }: { row: TranslocatorAuditEntry }) {
  return (
    <div className="px-3 py-2 text-xs space-y-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={row.action === "add" ? "secondary" : "destructive"}>{row.action}</Badge>
        <span className="font-mono text-[11px] text-muted-foreground">{row.segment_id}</span>
        <span className="text-muted-foreground">by</span>
        <span className="font-medium">{row.actor_display_name || row.actor_api_key_id || "—"}</span>
        <span className="text-muted-foreground ml-auto">{formatTimestamp(row.created_at)}</span>
      </div>
      {row.submission_stats && (
        <div className="text-[11px] text-muted-foreground">
          stats: <span className="font-mono">{JSON.stringify(row.submission_stats)}</span>
        </div>
      )}
    </div>
  );
}

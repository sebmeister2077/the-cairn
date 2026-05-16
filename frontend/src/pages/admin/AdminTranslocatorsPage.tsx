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

import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight, Loader2, Trash2, Users } from "lucide-react";

const ADMIN_TLS_KEY = ["admin-translocators"] as const;
const ADMIN_TLS_AUDIT_KEY = ["admin-translocators-audit"] as const;
const LIVE_PAGE_SIZE = 10;
const AUDIT_PAGE_SIZE = 20;
const ALL_CONTRIBUTORS = "__all";

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
  const [page, setPage] = useState(0);
  const [contributorId, setContributorId] = useState(ALL_CONTRIBUTORS);
  const [singleDeleteId, setSingleDeleteId] = useState<string | null>(null);
  const [bulkDeleteUser, setBulkDeleteUser] = useState<{
    id: string;
    label: string;
  } | null>(null);

  useEffect(() => {
    setPage(0);
  }, [contributorId]);

  const { data, isLoading, error } = useQuery({
    queryKey: [...ADMIN_TLS_KEY, page, contributorId],
    queryFn: () =>
      adminListTranslocators({
        actor_api_key_id: contributorId === ALL_CONTRIBUTORS ? undefined : contributorId,
        limit: LIVE_PAGE_SIZE,
        offset: page * LIVE_PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

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
    <Card className="">
      <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-base">Live submissions</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={contributorId}
            onValueChange={(value) => setContributorId(value ?? ALL_CONTRIBUTORS)}
          >
            <SelectTrigger size="sm" className="w-56 max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CONTRIBUTORS}>All contributors</SelectItem>
              {(data?.contributors ?? []).map((contributor) => (
                <SelectItem key={contributor.id} value={contributor.id}>
                  {contributor.name} ({contributor.id})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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
          <div className="overflow-hidden rounded-md border">
            <table className="w-full table-fixed text-xs">
              <colgroup>
                <col className="w-[11%]" />
                <col className="w-[17%]" />
                <col className="w-[21%]" />
                <col className="w-[17%]" />
                <col className="w-[8%]" />
                <col className="w-[10%]" />
                <col className="w-[7%]" />
                <col className="w-[9%]" />
              </colgroup>
              <thead className="text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="px-2 py-1.5 font-medium">Submitted</th>
                  <th className="px-2 py-1.5 font-medium">Contributor</th>
                  <th className="px-2 py-1.5 font-medium">Coordinates</th>
                  <th className="px-2 py-1.5 font-medium">Label</th>
                  <th
                    className="px-2 py-1.5 font-medium"
                    title="Self-reported existing-pair match %"
                  >
                    Match %
                  </th>
                  <th
                    className="px-2 py-1.5 font-medium"
                    title="Self-reported existing pairs they have"
                  >
                    Existing pairs
                  </th>
                  <th className="px-2 py-1.5 font-medium">Status</th>
                  <th className="px-2 py-1.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.translocators.map((row) => (
                  <TranslocatorRow
                    key={row.segment_id}
                    row={row}
                    deleting={
                      singleDeleteMut.isPending && singleDeleteMut.variables === row.segment_id
                    }
                    onDelete={() => setSingleDeleteId(row.segment_id)}
                    onBulkDelete={() => {
                      if (!row.actor_api_key_id) return;
                      setBulkDeleteUser({
                        id: row.actor_api_key_id,
                        label: row.actor_display_name || row.actor_api_key_id,
                      });
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <PageControls
            page={page}
            pageSize={LIVE_PAGE_SIZE}
            total={data.total}
            onPageChange={setPage}
          />
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
              ? `Hard-delete all live segment(s) contributed by ${bulkDeleteUser.label}? Each is captured in the audit log.`
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
  deleting,
  onDelete,
  onBulkDelete,
}: {
  row: AdminTranslocatorEntry;
  deleting: boolean;
  onDelete: () => void;
  onBulkDelete: () => void;
}) {
  return (
    <tr className="border-b last:border-b-0 hover:bg-muted/40">
      <td className="px-2 py-1.5 align-top">{formatTimestamp(row.created_at)}</td>
      <td className="px-2 py-1.5 align-top">
        <div className="font-medium wrap-break-word">{row.actor_display_name || "—"}</div>
        {row.actor_api_key_id && (
          <div className="break-all text-[10px] text-muted-foreground">{row.actor_api_key_id}</div>
        )}
      </td>
      <td className="wrap-break-word px-2 py-1.5 align-top font-mono">
        {fmtCoords(row.coordinates)}
      </td>
      <td className="wrap-break-word px-2 py-1.5 align-top">{row.label || "—"}</td>
      <td className="px-2 py-1.5 align-top">
        {statKey(row.submission_stats, "existing_match_pct")}
      </td>
      <td className="px-2 py-1.5 align-top">
        {statKey(row.submission_stats, "existing_pair_count")}
      </td>
      <td className="px-2 py-1.5 align-top">
        {row.still_present ? (
          <Badge variant="secondary">live</Badge>
        ) : (
          <Badge variant="outline">deleted</Badge>
        )}
      </td>
      <td className="px-2 py-1.5 align-top">
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
          {row.still_present && row.actor_api_key_id && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onBulkDelete}
              title={`Delete all from ${row.actor_display_name || row.actor_api_key_id}`}
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
  const [page, setPage] = useState(0);
  const { data, isLoading, error } = useQuery({
    queryKey: [...ADMIN_TLS_AUDIT_KEY, page],
    queryFn: () =>
      adminListTranslocatorAudit({ limit: AUDIT_PAGE_SIZE, offset: page * AUDIT_PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent audit</CardTitle>
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
        {data && (
          <PageControls
            page={page}
            pageSize={AUDIT_PAGE_SIZE}
            total={data.total}
            onPageChange={setPage}
          />
        )}
      </CardContent>
    </Card>
  );
}

function AuditRow({ row }: { row: TranslocatorAuditEntry }) {
  return (
    <div className="min-w-0 space-y-0.5 px-3 py-2 text-xs">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant={row.action === "add" ? "secondary" : "destructive"}>{row.action}</Badge>
        <span className="min-w-0 break-all font-mono text-[11px] text-muted-foreground">
          {row.segment_id}
        </span>
        <span className="text-muted-foreground">by</span>
        <span className="wrap-break-word font-medium">
          {row.actor_display_name || row.actor_api_key_id || "—"}
        </span>
        <span className="ml-auto whitespace-nowrap text-muted-foreground">
          {formatTimestamp(row.created_at)}
        </span>
      </div>
      {row.submission_stats && (
        <div className="wrap-break-word text-[11px] text-muted-foreground">
          stats: <span className="break-all font-mono">{JSON.stringify(row.submission_stats)}</span>
        </div>
      )}
    </div>
  );
}

function PageControls({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min(total, (page + 1) * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>
        {start}-{end} of {total}
      </span>
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
        <span>
          Page {Math.min(page + 1, pageCount)} of {pageCount}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))}
          disabled={page + 1 >= pageCount}
          title="Next page"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

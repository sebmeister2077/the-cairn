/**
 * Admin: User-contributed Traders (route: /manage/traders).
 *
 * Mirrors AdminTranslocatorsPage but for the traders dataset:
 *   1. Live user-contributed traders list with filter by contributor +
 *      trader type, single + bulk-by-user delete.
 *   2. Per-contributor sidebar showing total adds + last-7-day count.
 *   3. Recent audit feed (latest mutations: add / admin_edit / admin_delete
 *      / revert) with a Revert button per "add" row (flag-gated server-side
 *      by ``per_traders_revert``).
 *
 * All endpoints require the env-var admin API key.
 */

import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adminDeleteTrader,
  adminDeleteTradersByUser,
  adminListTraderAudit,
  adminListTraders,
  adminRevertTraderAudit,
  type AdminTraderRow,
  type AdminTraderAuditRow,
} from "@/lib/api";
import { TRADERS_QUERY_KEY } from "@/hooks/useOverlayData";
import { formatTimestamp } from "@/lib/utils";
import {
  TRADER_TYPES,
  TRADER_TYPE_LABELS,
  TRADER_TYPE_COLORS,
  isTraderType,
  type TraderType,
} from "@/lib/trader-types";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronLeft, ChevronRight, Loader2, Trash2, Undo2 } from "lucide-react";

const ADMIN_TRADERS_KEY = ["admin-traders"] as const;
const ADMIN_TRADERS_AUDIT_KEY = ["admin-traders-audit"] as const;
const LIVE_PAGE_SIZE = 25;
const AUDIT_PAGE_SIZE = 25;
const ALL_TYPES = "__all_types";
const ALL_CONTRIBUTORS = "__all";

function fmtCoords(coords: number[] | undefined): string {
  if (!Array.isArray(coords) || coords.length < 2) return "—";
  // Server stores +Z = south; flip for display.
  return `(${Math.round(coords[0]).toLocaleString()}, ${Math.round(-coords[1]).toLocaleString()})`;
}

function typeBadge(t: TraderType | null | undefined) {
  if (!t || !isTraderType(t)) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs">
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: TRADER_TYPE_COLORS[t] }}
      />
      {TRADER_TYPE_LABELS[t]}
    </span>
  );
}

export function AdminTradersPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">User-contributed Traders</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Live trader submissions, contributor stats, and the recent audit feed. Per-add reverts are
          gated by the <code className="font-mono text-xs">per_traders_revert</code> feature flag.
        </p>
      </div>
      <LiveTradersCard />
      <TraderAuditCard />
    </div>
  );
}

function LiveTradersCard() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [contributorId, setContributorId] = useState<string>(ALL_CONTRIBUTORS);
  const [typeFilter, setTypeFilter] = useState<string>(ALL_TYPES);
  const [singleDeleteId, setSingleDeleteId] = useState<string | null>(null);
  const [bulkDeleteUser, setBulkDeleteUser] = useState<{ id: string; label: string } | null>(null);

  useEffect(() => {
    setPage(0);
  }, [contributorId, typeFilter]);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: [...ADMIN_TRADERS_KEY, page, contributorId, typeFilter],
    queryFn: () =>
      adminListTraders({
        actor_api_key_id: contributorId === ALL_CONTRIBUTORS ? undefined : contributorId,
        trader_type:
          typeFilter === ALL_TYPES || !isTraderType(typeFilter)
            ? undefined
            : (typeFilter as TraderType),
        limit: LIVE_PAGE_SIZE,
        offset: page * LIVE_PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ADMIN_TRADERS_KEY });
    queryClient.invalidateQueries({ queryKey: ADMIN_TRADERS_AUDIT_KEY });
    queryClient.invalidateQueries({ queryKey: TRADERS_QUERY_KEY });
  };

  const singleDeleteMut = useMutation({
    mutationFn: (traderId: string) => adminDeleteTrader(traderId),
    onSuccess: invalidateAll,
  });
  const bulkDeleteMut = useMutation({
    mutationFn: (userId: string) => adminDeleteTradersByUser(userId),
    onSuccess: invalidateAll,
  });

  const traders: AdminTraderRow[] = data?.traders ?? [];
  const contributors = data?.contributors ?? [];
  const total = data?.total ?? 0;
  const nextOffset = data?.next_offset ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Live traders
          <span className="text-xs font-normal text-muted-foreground">
            ({total.toLocaleString()} total)
          </span>
          {isFetching && !isLoading && (
            <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> refreshing
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v ?? ALL_TYPES)}>
            <SelectTrigger className="h-8 w-56">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TYPES}>All types</SelectItem>
              {TRADER_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {TRADER_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={contributorId}
            onValueChange={(v) => setContributorId(v ?? ALL_CONTRIBUTORS)}
          >
            <SelectTrigger className="h-8 w-64">
              <SelectValue placeholder="All contributors" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CONTRIBUTORS}>All contributors</SelectItem>
              {contributors.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name} — {c.total_added} ({c.added_last_7d} last 7d)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {contributorId !== ALL_CONTRIBUTORS && (
            <Button
              variant="outline"
              size="sm"
              disabled={bulkDeleteMut.isPending}
              onClick={() => {
                const c = contributors.find((x) => x.id === contributorId);
                if (c) setBulkDeleteUser({ id: c.id, label: c.name });
              }}
            >
              {bulkDeleteMut.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-1" />
              )}
              {bulkDeleteMut.isPending ? "Deleting…" : "Delete all by this user"}
            </Button>
          )}
        </div>
        {isLoading && (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {error && (
          <p className="text-sm text-red-500">{(error as Error).message ?? "Failed to load"}</p>
        )}
        {!isLoading && traders.length === 0 && (
          <p className="text-sm text-muted-foreground">No traders match the current filter.</p>
        )}
        {traders.length > 0 && (
          <div className="overflow-x-auto rounded border">
            <Table className="text-sm">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">Type</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead className="w-32">Coords</TableHead>
                  <TableHead className="w-28">Match</TableHead>
                  <TableHead className="w-20">Flags</TableHead>
                  <TableHead className="w-40">Contributor</TableHead>
                  <TableHead className="w-24">Source</TableHead>
                  <TableHead className="w-40">Added</TableHead>
                  <TableHead className="w-12 text-right" aria-label="Actions" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {traders.map((t) => {
                  const status = (t.submission_stats ?? {}) as Record<string, unknown>;
                  const matchPoints =
                    typeof status.existing_match_pct === "number"
                      ? status.existing_match_pct
                      : null;
                  const matchCount =
                    typeof status.existing_match_count === "number"
                      ? status.existing_match_count
                      : null;
                  const displayMatchChip = matchPoints !== null && matchCount !== null;
                  const matchTone =
                    matchPoints == null
                      ? "text-muted-foreground"
                      : matchPoints >= 50
                        ? "text-amber-600"
                        : matchPoints >= 20
                          ? "text-yellow-600"
                          : "text-emerald-600";
                  const isRowDeleting =
                    singleDeleteMut.isPending && singleDeleteMut.variables === t.trader_id;

                  return (
                    <TableRow key={t.trader_id}>
                      <TableCell>
                        {typeBadge(t.trader_type) ?? (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="font-medium">
                        <span className="block truncate" title={t.label ?? undefined}>
                          {t.label || "(no label)"}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {fmtCoords(t.coordinates)}
                      </TableCell>
                      <TableCell>
                        {displayMatchChip ? (
                          <Badge
                            variant="outline"
                            className={matchTone}
                            title="Share of this submission that matched traders already on the map"
                          >
                            {matchPoints != null ? `${matchPoints.toFixed(1)}%` : "—"}
                            {matchCount != null ? ` (${matchCount})` : ""}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {t.duplicate_flagged ? (
                          <Badge variant="outline" className="text-amber-600">
                            dup?
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        <span className="block truncate" title={t.actor_display_name ?? undefined}>
                          {t.actor_display_name ?? "—"}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {t.source ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatTimestamp(t.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Delete trader"
                          disabled={isRowDeleting}
                          onClick={() => setSingleDeleteId(t.trader_id)}
                        >
                          {isRowDeleting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <Pagination page={page} onPage={setPage} hasNext={nextOffset != null} />
      </CardContent>

      <ConfirmDialog
        open={singleDeleteId != null}
        onCancel={() => setSingleDeleteId(null)}
        title="Delete trader?"
        description="Removes this trader from the live geojson. The before-snapshot stays in the audit log."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => {
          if (singleDeleteId) singleDeleteMut.mutate(singleDeleteId);
          setSingleDeleteId(null);
        }}
      />
      <ConfirmDialog
        open={bulkDeleteUser != null}
        onCancel={() => setBulkDeleteUser(null)}
        title={`Delete all traders by ${bulkDeleteUser?.label ?? "user"}?`}
        description="Hard-deletes every still-present trader added by this contributor. Recoverable from the audit log."
        confirmLabel="Delete all"
        variant="destructive"
        onConfirm={() => {
          if (bulkDeleteUser) bulkDeleteMut.mutate(bulkDeleteUser.id);
          setBulkDeleteUser(null);
        }}
      />
    </Card>
  );
}

function TraderAuditCard() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [actionFilter, setActionFilter] = useState<string>("__all_actions");
  const [typeFilter, setTypeFilter] = useState<string>(ALL_TYPES);
  const [revertTarget, setRevertTarget] = useState<AdminTraderAuditRow | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);

  useEffect(() => {
    setPage(0);
  }, [actionFilter, typeFilter]);

  const { data, isLoading, error } = useQuery({
    queryKey: [...ADMIN_TRADERS_AUDIT_KEY, page, actionFilter, typeFilter],
    queryFn: () =>
      adminListTraderAudit({
        action: actionFilter === "__all_actions" ? undefined : actionFilter,
        trader_type:
          typeFilter === ALL_TYPES || !isTraderType(typeFilter)
            ? undefined
            : (typeFilter as TraderType),
        limit: AUDIT_PAGE_SIZE,
        offset: page * AUDIT_PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  const revertMut = useMutation({
    mutationFn: (id: number) => adminRevertTraderAudit(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_TRADERS_KEY });
      queryClient.invalidateQueries({ queryKey: ADMIN_TRADERS_AUDIT_KEY });
      queryClient.invalidateQueries({ queryKey: TRADERS_QUERY_KEY });
    },
    onError: (e) => {
      setRevertError(e instanceof Error ? e.message : "Revert failed");
    },
  });

  const audit: AdminTraderAuditRow[] = data?.audit ?? [];
  const total = data?.total ?? 0;
  const nextOffset = data?.next_offset ?? null;

  const actionOptions = useMemo(() => ["add", "admin_edit", "admin_delete", "revert"] as const, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Audit log
          <span className="text-xs font-normal text-muted-foreground">
            ({total.toLocaleString()} entries)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={actionFilter} onValueChange={(v) => setActionFilter(v ?? "__all_actions")}>
            <SelectTrigger className="h-8 w-48">
              <SelectValue placeholder="All actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all_actions">All actions</SelectItem>
              {actionOptions.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v ?? ALL_TYPES)}>
            <SelectTrigger className="h-8 w-56">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TYPES}>All types</SelectItem>
              {TRADER_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {TRADER_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {revertError && (
          <p className="text-sm text-red-500" role="alert">
            {revertError}
          </p>
        )}
        {isLoading && (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {error && (
          <p className="text-sm text-red-500">{(error as Error).message ?? "Failed to load"}</p>
        )}
        {audit.length > 0 && (
          <ul className="space-y-1 text-sm">
            {audit.map((r) => {
              const after = (r.after_payload?.properties ?? {}) as {
                label?: string;
              };
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-2 rounded border px-2 py-1.5"
                >
                  <Badge variant="outline">{r.action}</Badge>
                  {typeBadge(r.trader_type)}
                  <span className="font-medium">{after.label || r.trader_id}</span>
                  <span className="text-xs text-muted-foreground">{r.source ?? "—"}</span>
                  {r.duplicate_flagged && (
                    <Badge variant="outline" className="text-amber-600">
                      dup
                    </Badge>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    by {r.actor_display_name ?? "—"} · {formatTimestamp(r.created_at)}
                  </span>
                  {r.action === "add" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Revert this add"
                      onClick={() => setRevertTarget(r)}
                    >
                      <Undo2 className="h-4 w-4" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <Pagination page={page} onPage={setPage} hasNext={nextOffset != null} />
      </CardContent>

      <ConfirmDialog
        open={revertTarget != null}
        onCancel={() => setRevertTarget(null)}
        title="Revert this trader addition?"
        description={
          "Removes the trader from the live geojson and writes a revert row to the audit log. " +
          "Requires the `per_traders_revert` feature flag to be enabled."
        }
        confirmLabel="Revert"
        variant="destructive"
        onConfirm={() => {
          if (revertTarget) revertMut.mutate(revertTarget.id);
          setRevertTarget(null);
          setRevertError(null);
        }}
      />
    </Card>
  );
}

function Pagination({
  page,
  onPage,
  hasNext,
}: {
  page: number;
  onPage: (p: number) => void;
  hasNext: boolean;
}) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <Button
        variant="outline"
        size="sm"
        disabled={page === 0}
        onClick={() => onPage(Math.max(0, page - 1))}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="text-xs text-muted-foreground">Page {page + 1}</span>
      <Button variant="outline" size="sm" disabled={!hasNext} onClick={() => onPage(page + 1)}>
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  activateAllPendingMapLevels,
  activateMapLevel,
  deleteMapLevel,
  getMapGenerationStatus,
  markMapLevelStatus,
  refreshMapMetadata,
  requestMapGeneration,
  rollbackMapLevel,
  stopMapGeneration,
  type MapGenerationStatus,
  type MapGenerationLevelStatus,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Loader2,
  Trash2,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Circle,
  OctagonX,
  FileCog,
  Rocket,
  Undo2,
  Clock,
} from "lucide-react";

const STATUS_QUERY_KEY = ["admin-tops-map-generation-status"];
const POLL_INTERVAL_MS = 2000;

interface ResolutionPanelProps {
  /** Optional callback fired when generation completes for any level. */
  onLevelComplete?: () => void;
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Format a duration in milliseconds as a short human string (e.g. "2m 30s"). */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Estimate remaining time for a generating level based on chunks completed
 * since `started_at`. Returns null when not enough data is available
 * (no start time, no chunks done yet, or all chunks already done).
 */
function computeEtaMs(entry: MapGenerationLevelStatus | undefined, nowMs: number): number | null {
  if (!entry || entry.status !== "generating") return null;
  if (!entry.started_at || entry.total_chunks <= 0) return null;
  const completed = entry.completed_chunks;
  const remaining = entry.total_chunks - completed;
  if (completed <= 0 || remaining <= 0) return null;
  const startedMs = new Date(entry.started_at).getTime();
  if (!Number.isFinite(startedMs)) return null;
  const elapsed = nowMs - startedMs;
  if (elapsed <= 0) return null;
  return (elapsed / completed) * remaining;
}

function StatusBadge({ status }: { status: MapGenerationLevelStatus["status"] }) {
  if (status === "complete") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
        <CheckCircle2 className="size-3" /> Generated
      </span>
    );
  }
  if (status === "generating") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-400">
        <Loader2 className="size-3 animate-spin" /> Generating
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">
        <AlertCircle className="size-3" /> Failed
      </span>
    );
  }
  if (status === "pending_activation") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <Clock className="size-3" /> Pending activation
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <Circle className="size-3" /> Not generated
    </span>
  );
}

export function AdminResolutionPanel({ onLevelComplete }: ResolutionPanelProps) {
  const queryClient = useQueryClient();

  const statusQuery = useQuery<MapGenerationStatus>({
    queryKey: STATUS_QUERY_KEY,
    queryFn: getMapGenerationStatus,
    // Poll while a job is running.
    refetchInterval: (query) => (query.state.data?.is_running ? POLL_INTERVAL_MS : false),
    refetchOnWindowFocus: true,
  });

  const generateMutation = useMutation({
    mutationFn: (levels?: number[]) => requestMapGeneration(levels),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (level: number) => deleteMapLevel(level),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => stopMapGeneration(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    },
  });

  const refreshMetadataMutation = useMutation({
    mutationFn: () => refreshMapMetadata(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    },
  });

  const markMutation = useMutation({
    mutationFn: ({ level, status }: { level: number; status: "complete" | "failed" }) =>
      markMapLevelStatus(
        level,
        status,
        status === "failed" ? "Marked failed manually by admin" : undefined,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    },
  });

  // Flipping the pointer changes which R2 prefix the public chunk-URL
  // endpoints resolve to, so the cached presigned URLs on the map view
  // (queryKey: ["tops-map-level", n]) and the aggregate stats query
  // (["tops-map-stats"]) MUST be invalidated alongside the admin status —
  // otherwise the viewer keeps loading stale chunks from the previously
  // live bundle (e.g. the legacy bare prefix) until React Query's
  // staleTime expires, which manifests as PNG-tile-aligned "stale chunk"
  // bands on the map immediately after activation.
  const invalidatePublicMapCaches = () => {
    queryClient.invalidateQueries({ queryKey: ["tops-map-level"] });
    queryClient.invalidateQueries({ queryKey: ["tops-map-stats"] });
  };

  const activateMutation = useMutation({
    mutationFn: (level: number) => activateMapLevel(level),
    onSuccess: (data) => {
      queryClient.setQueryData(STATUS_QUERY_KEY, data);
      queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
      invalidatePublicMapCaches();
      onLevelComplete?.();
    },
  });

  const activateAllMutation = useMutation({
    mutationFn: () => activateAllPendingMapLevels(),
    onSuccess: (data) => {
      queryClient.setQueryData(STATUS_QUERY_KEY, data);
      queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
      invalidatePublicMapCaches();
      onLevelComplete?.();
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: (level: number) => rollbackMapLevel(level),
    onSuccess: (data) => {
      queryClient.setQueryData(STATUS_QUERY_KEY, data);
      queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
      invalidatePublicMapCaches();
      onLevelComplete?.();
    },
  });

  // Pending confirmation state for the destructive/manual actions.
  type PendingAction =
    | { kind: "delete"; level: number }
    | { kind: "mark"; level: number; status: "complete" | "failed" }
    | { kind: "rollback"; level: number };
  const [pending, setPending] = useState<PendingAction | null>(null);

  const closeConfirm = () => setPending(null);
  const runConfirm = () => {
    if (!pending) return;
    if (pending.kind === "delete") {
      deleteMutation.mutate(pending.level, { onSettled: closeConfirm });
    } else if (pending.kind === "rollback") {
      rollbackMutation.mutate(pending.level, { onSettled: closeConfirm });
    } else {
      markMutation.mutate(
        { level: pending.level, status: pending.status },
        { onSettled: closeConfirm },
      );
    }
  };

  // Detect transition from running → idle to notify parent (e.g. refresh image).
  const isRunning = statusQuery.data?.is_running ?? false;
  const stopRequested = statusQuery.data?.stop_requested ?? false;
  useEffect(() => {
    if (!isRunning && statusQuery.data && onLevelComplete) {
      onLevelComplete();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  // Tick every second while running so the ETA display refreshes smoothly
  // between status polls (which only happen every POLL_INTERVAL_MS).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isRunning]);

  const rows = useMemo(() => {
    const data = statusQuery.data;
    if (!data) return [];
    return data.configured_levels.map((cfg) => ({
      ...cfg,
      entry: data.levels[String(cfg.level)] as MapGenerationLevelStatus | undefined,
    }));
  }, [statusQuery.data]);

  const errorMessage =
    generateMutation.error instanceof Error
      ? generateMutation.error.message
      : deleteMutation.error instanceof Error
        ? deleteMutation.error.message
        : stopMutation.error instanceof Error
          ? stopMutation.error.message
          : markMutation.error instanceof Error
            ? markMutation.error.message
            : refreshMetadataMutation.error instanceof Error
              ? refreshMetadataMutation.error.message
              : activateMutation.error instanceof Error
                ? activateMutation.error.message
                : activateAllMutation.error instanceof Error
                  ? activateAllMutation.error.message
                  : rollbackMutation.error instanceof Error
                    ? rollbackMutation.error.message
                    : null;

  const refreshMetadataSuccess = refreshMetadataMutation.data?.refreshed ?? null;

  const pendingCount = rows.filter((r) => Boolean(r.entry?.pending_version)).length;
  const anyMutationPending =
    activateMutation.isPending || activateAllMutation.isPending || rollbackMutation.isPending;

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-medium">Map resolution cache</h3>
          <p className="text-xs text-muted-foreground">
            Generate or refresh pre-rendered TOPS map images at multiple zoom levels. Higher levels
            = more detail, more storage.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => statusQuery.refetch()}
            disabled={statusQuery.isFetching}
          >
            <RefreshCw className={`size-3 ${statusQuery.isFetching ? "animate-spin" : ""}`} />
          </Button>
          {isRunning && (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => stopMutation.mutate()}
              disabled={stopRequested || stopMutation.isPending}
              title="Stop after current chunk and discard queued requests"
            >
              {stopRequested ? (
                <>
                  <Loader2 className="size-3 mr-1 animate-spin" />
                  Stopping…
                </>
              ) : (
                <>
                  <OctagonX className="size-3 mr-1" />
                  Stop
                </>
              )}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => refreshMetadataMutation.mutate()}
            disabled={isRunning || refreshMetadataMutation.isPending}
            title="Recompute and re-upload each level's metadata.json from the current combined DB without re-rendering chunks. Fixes overlay misalignment caused by drifted per-level bounds."
          >
            {refreshMetadataMutation.isPending ? (
              <>
                <Loader2 className="size-3 mr-1 animate-spin" />
                Refreshing…
              </>
            ) : (
              <>
                <FileCog className="size-3 mr-1" />
                Refresh metadata
              </>
            )}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => generateMutation.mutate(undefined)}
            disabled={isRunning || generateMutation.isPending}
          >
            {isRunning ? (
              <>
                <Loader2 className="size-3 mr-1 animate-spin" />
                Generating…
              </>
            ) : (
              "Generate all levels"
            )}
          </Button>
          {pendingCount > 0 && (
            <Button
              type="button"
              size="sm"
              variant="default"
              className="bg-amber-600 hover:bg-amber-700 text-white"
              onClick={() => activateAllMutation.mutate()}
              disabled={anyMutationPending}
              title={`Activate ${pendingCount} staged level${pendingCount === 1 ? "" : "s"}: flip the live pointer so users see the freshly generated map. Levels currently being regenerated are skipped.`}
            >
              {activateAllMutation.isPending ? (
                <>
                  <Loader2 className="size-3 mr-1 animate-spin" />
                  Activating…
                </>
              ) : (
                <>
                  <Rocket className="size-3 mr-1" />
                  Activate all pending ({pendingCount})
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {errorMessage && <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>}

      {refreshMetadataSuccess && !refreshMetadataMutation.isPending && (
        <p className="text-xs text-green-700 dark:text-green-400">
          Metadata refreshed for {refreshMetadataSuccess.length} level
          {refreshMetadataSuccess.length === 1 ? "" : "s"}:{" "}
          {refreshMetadataSuccess
            .map((m) => `L${m.level} (start_x=${m.start_x}, w=${m.width_blocks})`)
            .join(", ")}
        </p>
      )}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Level</th>
              <th className="px-3 py-2">Resolution</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Progress</th>
              <th className="px-3 py-2">Size</th>
              <th className="px-3 py-2">Generated</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ level, max_dimension, entry }) => {
              const status = entry?.status ?? "not_generated";
              const progress = entry?.progress ?? 0;
              const etaMs = computeEtaMs(entry, nowMs);
              return (
                <tr key={level} className="border-t">
                  <td className="px-3 py-2 font-medium">L{level}</td>
                  <td className="px-3 py-2">
                    {level === 5 ? "Full resolution" : `${max_dimension.toLocaleString()} px`}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={status} />
                    {status === "failed" && entry?.error && (
                      <p className="mt-1 text-xs text-red-600 dark:text-red-400">{entry.error}</p>
                    )}
                    {entry?.pending_version && (
                      <p
                        className="mt-1 text-[10px] text-amber-700 dark:text-amber-400 truncate max-w-[18ch]"
                        title={`Staged bundle ${entry.pending_version} (${formatBytes(entry.pending_size_bytes)}) generated ${formatTimestamp(entry.pending_generated_at)}. Awaiting activation.`}
                      >
                        pending: {entry.pending_version}
                      </p>
                    )}
                    {entry?.previous_version && (
                      <p
                        className="mt-1 text-[10px] text-muted-foreground truncate max-w-[18ch]"
                        title={`Previous live bundle ${entry.previous_version} \u2014 available for one-step rollback.`}
                      >
                        prev: {entry.previous_version}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {status === "generating" ? (
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full bg-blue-500 transition-all"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground">{progress}%</span>
                        {entry?.current_chunk && (
                          <span className="text-xs text-muted-foreground">
                            ({entry.completed_chunks}/{entry.total_chunks})
                          </span>
                        )}
                        {etaMs == null ? null : (
                          <span
                            className="text-xs text-muted-foreground"
                            title="Estimated time remaining (client-side estimate based on chunks completed since start)"
                          >
                            · ETA ~{formatDuration(etaMs)}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {formatBytes(entry?.size_bytes)}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {formatTimestamp(entry?.generated_at)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex flex-wrap justify-end gap-1">
                      {entry?.pending_version && (
                        <Button
                          type="button"
                          size="sm"
                          className="bg-amber-600 hover:bg-amber-700 text-white"
                          onClick={() => activateMutation.mutate(level)}
                          disabled={status === "generating" || anyMutationPending}
                          title={`Promote staged version ${entry.pending_version} to live.`}
                        >
                          {activateMutation.isPending && activateMutation.variables === level ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <>
                              <Rocket className="size-3 mr-1" />
                              Activate
                            </>
                          )}
                        </Button>
                      )}
                      {entry?.previous_version && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setPending({ kind: "rollback", level })}
                          disabled={status === "generating" || anyMutationPending}
                          title={`Roll back to previous version ${entry.previous_version}.`}
                        >
                          <Undo2 className="size-3" />
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => generateMutation.mutate([level])}
                        disabled={isRunning || generateMutation.isPending}
                      >
                        {status === "complete" || status === "pending_activation"
                          ? "Regenerate"
                          : "Generate"}
                      </Button>
                      {status !== "complete" && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setPending({ kind: "mark", level, status: "complete" })}
                          disabled={isRunning || markMutation.isPending}
                          title="Manually mark this level as complete (does not render anything)"
                        >
                          <CheckCircle2 className="size-3" />
                        </Button>
                      )}
                      {status !== "failed" && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setPending({ kind: "mark", level, status: "failed" })}
                          disabled={isRunning || markMutation.isPending}
                          title="Manually mark this level as failed"
                        >
                          <AlertCircle className="size-3" />
                        </Button>
                      )}
                      {status === "complete" && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setPending({ kind: "delete", level })}
                          disabled={isRunning || deleteMutation.isPending}
                          title="Delete cached level"
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {statusQuery.isLoading ? "Loading…" : "No resolution levels configured."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={pending?.kind === "delete"}
        title={pending?.kind === "delete" ? `Delete cached level ${pending.level}?` : ""}
        description="This wipes the level's rendered chunks and assembled image from R2 storage. The combined map DB itself is untouched. You can regenerate afterwards."
        confirmLabel="Delete"
        variant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={runConfirm}
        onCancel={closeConfirm}
      />

      <ConfirmDialog
        open={pending?.kind === "mark" && pending.status === "complete"}
        title={
          pending?.kind === "mark" && pending.status === "complete"
            ? `Mark level ${pending.level} as complete?`
            : ""
        }
        description="This only updates the status indicator — no chunks will be rendered. Use this to clear a stale 'failed' badge when you know the cached chunks are actually fine."
        confirmLabel="Mark complete"
        loading={markMutation.isPending}
        onConfirm={runConfirm}
        onCancel={closeConfirm}
      />

      <ConfirmDialog
        open={pending?.kind === "mark" && pending.status === "failed"}
        title={
          pending?.kind === "mark" && pending.status === "failed"
            ? `Mark level ${pending.level} as failed?`
            : ""
        }
        description="This only updates the status indicator. The rendered chunks (if any) stay in R2. Useful for flagging a known-bad level so it stops showing as generated."
        confirmLabel="Mark failed"
        variant="destructive"
        loading={markMutation.isPending}
        onConfirm={runConfirm}
        onCancel={closeConfirm}
      />

      <ConfirmDialog
        open={pending?.kind === "rollback"}
        title={pending?.kind === "rollback" ? `Roll back level ${pending.level}?` : ""}
        description="Restore the previous live version of this level. The bundle that is currently live will be retained as the new previous, so you can re-roll back if needed. Any staged pending version is left untouched."
        confirmLabel="Roll back"
        variant="destructive"
        loading={rollbackMutation.isPending}
        onConfirm={runConfirm}
        onCancel={closeConfirm}
      />
    </div>
  );
}

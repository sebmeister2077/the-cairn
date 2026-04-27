import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    deleteMapLevel,
    getMapGenerationStatus,
    requestMapGeneration,
    type MapGenerationStatus,
    type MapGenerationLevelStatus,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Loader2, Trash2, RefreshCw, CheckCircle2, AlertCircle, Circle } from "lucide-react";

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
        refetchInterval: (query) =>
            query.state.data?.is_running ? POLL_INTERVAL_MS : false,
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

    // Detect transition from running → idle to notify parent (e.g. refresh image).
    const isRunning = statusQuery.data?.is_running ?? false;
    useEffect(() => {
        if (!isRunning && statusQuery.data && onLevelComplete) {
            onLevelComplete();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isRunning]);

    const rows = useMemo(() => {
        const data = statusQuery.data;
        if (!data) return [];
        return data.configured_levels.map((cfg) => ({
            ...cfg,
            entry: data.levels[String(cfg.level)] as MapGenerationLevelStatus | undefined,
        }));
    }, [statusQuery.data]);

    const errorMessage = generateMutation.error instanceof Error
        ? generateMutation.error.message
        : deleteMutation.error instanceof Error
            ? deleteMutation.error.message
            : null;

    return (
        <div className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
                <div>
                    <h3 className="text-base font-medium">Map resolution cache</h3>
                    <p className="text-xs text-muted-foreground">
                        Generate or refresh pre-rendered TOPS map images at multiple zoom levels. Higher levels = more detail, more storage.
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
                </div>
            </div>

            {errorMessage && (
                <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
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
                                        <div className="inline-flex gap-1">
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                onClick={() => generateMutation.mutate([level])}
                                                disabled={isRunning || generateMutation.isPending}
                                            >
                                                {status === "complete" ? "Regenerate" : "Generate"}
                                            </Button>
                                            {status === "complete" && (
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() => {
                                                        if (window.confirm(`Delete cached level ${level}? This will also remove its chunks.`)) {
                                                            deleteMutation.mutate(level);
                                                        }
                                                    }}
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
        </div>
    );
}

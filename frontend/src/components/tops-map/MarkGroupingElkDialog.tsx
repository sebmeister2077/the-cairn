import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, PawPrint, AlertTriangle, Flag, Eye, EyeOff, MapPin } from "lucide-react";

import type { WorldLineSegment } from "@/components/MapViewer";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  consumeDialogStateSnapshot,
  enterPreview,
  type PreviewWalkSegment,
} from "@/store/slices/topsMapPreview";
import { useTranslation } from "@/lib/i18n";
import { tlIdFor, type TLGrouping } from "@/lib/tl-groupings";
import { ELK_WALKABLE_QUERY_KEY, useElkWalkable } from "@/hooks/useElkWalkable";
import { getMyAccountSafe, submitElkWalkable } from "@/lib/api";
import {
  classifyGroupingEdges,
  enumerateGroupingEdges,
  DEFAULT_MAX_WALK_BLOCKS,
  MAX_MAX_WALK_BLOCKS,
  MIN_MAX_WALK_BLOCKS,
  type ClassifiedGroupingEdge,
} from "@/lib/elk-grouping";
import type { WalkLegElkState } from "@/lib/elk-walkable";
import { Slider } from "@/components/ui/slider";
import { ReportElkEdgeDialog } from "./routeplanner/ReportElkEdgeDialog";

interface MarkGroupingElkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  grouping: TLGrouping | null;
  allSegments: WorldLineSegment[];
}

/** Same colour vocabulary as ElkWalkableSection so the dialog reads as
 *  an extension of the planner's elk legend. */
const STATE_DOT_CLASS: Record<WalkLegElkState, string> = {
  "not-attestable": "bg-slate-200 dark:bg-slate-700",
  unconfirmed: "bg-slate-300 dark:bg-slate-600",
  confirmed: "bg-sky-400",
  "confirmed-by-me": "bg-sky-500",
  "pending-attest": "bg-amber-400",
  "pending-unattest": "bg-red-400",
};

const STATE_ROW_CLASS: Record<WalkLegElkState, string> = {
  "not-attestable": "bg-muted/30 text-muted-foreground",
  unconfirmed: "bg-slate-50 text-slate-700 dark:bg-slate-900/40 dark:text-slate-200",
  confirmed: "bg-sky-50 text-sky-900 dark:bg-sky-950/30 dark:text-sky-100",
  "confirmed-by-me": "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100",
  "pending-attest": "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100",
  "pending-unattest": "bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-100",
};

export function MarkGroupingElkDialog({
  open,
  onOpenChange,
  grouping,
  allSegments,
}: MarkGroupingElkDialogProps) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const apiKey = useAppSelector((s) => s.auth.apiKey);
  const kNeighbors = useAppSelector((s) => s.routePlanner.kNeighbors);
  const walkSpeed = useAppSelector((s) => s.routePlanner.walkSpeed);
  const confirmedEdges = useAppSelector((s) => s.elkWalkable.edges);
  const pendingAttest = useAppSelector((s) => s.elkWalkable.pendingAttest);
  const pendingUnattest = useAppSelector((s) => s.elkWalkable.pendingUnattest);
  const dialogStateSnapshot = useAppSelector((s) => s.topsMapPreview.dialogStateSnapshot);

  // Initialise from a snapshot if we're being remounted by the drawer
  // after exiting preview mode. `useState`'s lazy initialiser only runs
  // once, so we don't need a separate "hydrated" flag — we just consume
  // the snapshot in an effect right after mount.
  const [showAllRows, setShowAllRows] = useState<boolean>(
    () => dialogStateSnapshot?.showAllRows ?? false,
  );
  const [reportEdge, setReportEdge] = useState<{ key: string; label: string } | null>(null);
  const [maxWalkBlocks, setMaxWalkBlocks] = useState<number>(
    () => dialogStateSnapshot?.maxWalkBlocks ?? DEFAULT_MAX_WALK_BLOCKS,
  );
  const [ignoredKeys, setIgnoredKeys] = useState<Set<string>>(
    () => new Set(dialogStateSnapshot?.ignoredKeys ?? []),
  );

  // One-shot consume — only the very first mount of this open cycle
  // should clear the snapshot. Re-renders triggered by the consume
  // dispatch must NOT re-run this.
  const consumedSnapshotRef = useRef(false);
  useEffect(() => {
    if (!open) {
      consumedSnapshotRef.current = false;
      return;
    }
    if (dialogStateSnapshot && !consumedSnapshotRef.current) {
      consumedSnapshotRef.current = true;
      dispatch(consumeDialogStateSnapshot());
    }
  }, [open, dialogStateSnapshot, dispatch]);

  // Make sure the elk file is loaded once the dialog is opened — otherwise
  // `confirmedEdges` would be empty on first paint and the "already
  // elk-friendly" counter would lie.
  useElkWalkable();

  const accountQuery = useQuery({
    queryKey: ["account-me", apiKey ?? ""],
    queryFn: getMyAccountSafe,
    staleTime: 60_000,
    retry: false,
    enabled: open,
  });
  const selfUserId = accountQuery.data?.user?.id ?? null;

  const enumeration = useMemo(() => {
    if (!open || !grouping) return null;
    return enumerateGroupingEdges(grouping, allSegments, {
      kNeighbors,
      walkSpeed,
      maxWalkBlocks,
    });
  }, [open, grouping, allSegments, kNeighbors, walkSpeed, maxWalkBlocks]);

  const pendingAttestKeys = useMemo(
    () => new Set(pendingAttest.map((p) => p.key)),
    [pendingAttest],
  );
  const pendingUnattestKeys = useMemo(
    () => new Set(pendingUnattest.map((p) => p.key)),
    [pendingUnattest],
  );

  const classification = useMemo(() => {
    if (!enumeration) return null;
    return classifyGroupingEdges(
      enumeration.edges,
      confirmedEdges,
      pendingAttestKeys,
      pendingUnattestKeys,
      selfUserId,
    );
  }, [enumeration, confirmedEdges, pendingAttestKeys, pendingUnattestKeys, selfUserId]);

  // Indexed once for O(1) endpoint lookup when materialising preview
  // segments. Kept above the early `return null` so hook order stays
  // stable across renders where `grouping` is null.
  const segmentsById = useMemo(() => {
    const map = new Map<string, WorldLineSegment>();
    for (const seg of allSegments) {
      const id = seg.id ?? tlIdFor(seg);
      if (id) map.set(id, seg);
    }
    return map;
  }, [allSegments]);

  // Mutation must live above the early `return null` below — otherwise
  // the hook-call order changes between the first render (grouping=null)
  // and subsequent renders, which React reports as a hooks-order bug.
  const queryClient = useQueryClient();
  const stageableForSubmit = (classification?.summary.stageable ?? []).filter(
    (e) => !ignoredKeys.has(e.key),
  );
  const submitMut = useMutation({
    mutationFn: async () => {
      if (stageableForSubmit.length === 0) throw new Error("nothing to submit");
      return submitElkWalkable({
        attest: stageableForSubmit.map((e) => ({ a: e.a, b: e.b })),
        unattest: [],
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [...ELK_WALKABLE_QUERY_KEY] });
      onOpenChange(false);
    },
  });

  if (!grouping) return null;

  const summary = classification?.summary;
  const edges: ClassifiedGroupingEdge[] = classification?.edges ?? [];
  const skipped = enumeration?.skipped ?? [];
  // Ignored edges are visually retained in the list (state-driven UI)
  // but excluded from staging so the bulk-attest button reflects what
  // will actually be saved.
  const stageable = stageableForSubmit;
  const stageableCount = stageable.length;
  const ignoredStageableCount = (summary?.stageable.length ?? 0) - stageableCount;
  const allDone = summary != null && summary.total > 0 && summary.unconfirmed === 0;

  const buildPreviewSegments = (): PreviewWalkSegment[] => {
    const out: PreviewWalkSegment[] = [];
    for (const edge of edges) {
      const segA = segmentsById.get(edge.a.tl_id);
      const segB = segmentsById.get(edge.b.tl_id);
      if (!segA || !segB) continue;
      const fromX = edge.a.ep === 0 ? segA.x1 : segA.x2;
      const fromZ = edge.a.ep === 0 ? segA.z1 : segA.z2;
      const toX = edge.b.ep === 0 ? segB.x1 : segB.x2;
      const toZ = edge.b.ep === 0 ? segB.z1 : segB.z2;
      out.push({
        key: edge.key,
        fromX,
        fromZ,
        toX,
        toZ,
        elkState: edge.state,
      });
    }
    return out;
  };

  const handleConfirm = () => {
    if (submitMut.isPending) return;
    submitMut.mutate();
  };

  const handleEnterPreview = (focusEdgeKey: string | null) => {
    if (!grouping) return;
    dispatch(
      enterPreview({
        groupingId: grouping.id,
        segments: buildPreviewSegments(),
        focusEdgeKey,
        dialogStateSnapshot: {
          ignoredKeys: Array.from(ignoredKeys),
          maxWalkBlocks,
          showAllRows,
        },
      }),
    );
  };

  const toggleIgnored = (key: string) => {
    setIgnoredKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const visibleEdges = showAllRows ? edges : edges.slice(0, 12);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl lg:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PawPrint className="size-5 text-emerald-600" />
            <span className="flex-1 truncate">
              {t("topsMap.markGroupingElk.title", { name: grouping.name })}
            </span>
            {edges.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 gap-1.5 text-xs mr-8"
                onClick={() => handleEnterPreview(null)}
                title={t("topsMap.markGroupingElk.previewHint")}
              >
                <Eye className="size-3.5" />
                {t("topsMap.markGroupingElk.preview")}
              </Button>
            )}
          </DialogTitle>
          <DialogDescription>{t("topsMap.markGroupingElk.description")}</DialogDescription>
        </DialogHeader>

        {!enumeration ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("topsMap.markGroupingElk.computing")}
          </div>
        ) : enumeration.includedCount < 2 ? (
          <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            {t("topsMap.markGroupingElk.notEnoughTls")}
          </div>
        ) : (
          <div className="space-y-3">
            {/* Stat block */}
            <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t("topsMap.markGroupingElk.alreadyConfirmed")}
                </div>
                <div className="font-semibold">
                  {t("topsMap.markGroupingElk.confirmedOfTotal", {
                    confirmed: summary?.confirmed ?? 0,
                    total: summary?.total ?? 0,
                  })}
                </div>
                {(summary?.confirmedByMe ?? 0) > 0 && (
                  <div className="text-xs text-muted-foreground">
                    {t("topsMap.markGroupingElk.confirmedByMe", {
                      count: summary?.confirmedByMe ?? 0,
                    })}
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t("topsMap.markGroupingElk.willStage")}
                </div>
                <div className="font-semibold">
                  {t("topsMap.markGroupingElk.willStageCount", { count: stageableCount })}
                </div>
                {(summary?.pendingAttest ?? 0) > 0 && (
                  <div className="text-xs text-muted-foreground">
                    {t("topsMap.markGroupingElk.alreadyInDraft", {
                      count: summary?.pendingAttest ?? 0,
                    })}
                  </div>
                )}
                {ignoredStageableCount > 0 && (
                  <div className="text-xs text-muted-foreground">
                    {t("topsMap.markGroupingElk.ignoredCount", {
                      count: ignoredStageableCount,
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Skipped warning */}
            {skipped.length > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-100">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  {t("topsMap.markGroupingElk.skippedWarning", { count: skipped.length })}
                </span>
              </div>
            )}

            {/* Max-walk-distance filter — pure K-NN over a small grouping
                wires every TL pair together regardless of distance, so a
                user-tunable cap is what turns "every pair" into "only
                walks you'd actually do". */}
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium uppercase tracking-wide text-muted-foreground">
                  {t("topsMap.markGroupingElk.maxWalkLabel")}
                </span>
                <span className="font-mono tabular-nums">
                  {t("topsMap.markGroupingElk.maxWalkValue", { count: maxWalkBlocks })}
                </span>
              </div>
              <Slider
                value={maxWalkBlocks}
                min={MIN_MAX_WALK_BLOCKS}
                max={MAX_MAX_WALK_BLOCKS}
                step={10}
                onValueChange={setMaxWalkBlocks}
                aria-label={t("topsMap.markGroupingElk.maxWalkLabel")}
              />
            </div>

            {/* Edge list */}
            {edges.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("topsMap.markGroupingElk.edgesHeading")}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {t("topsMap.markGroupingElk.edgesShown", {
                      shown: visibleEdges.length,
                      total: edges.length,
                    })}
                  </span>
                </div>
                <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border p-1 text-[11px]">
                  {visibleEdges.map((edge) => {
                    const ignored = ignoredKeys.has(edge.key);
                    const isConfirmed =
                      edge.state === "confirmed" || edge.state === "confirmed-by-me";
                    const isUnconfirmed = edge.state === "unconfirmed";
                    const edgeLabel = `${edge.a.tl_id}#${edge.a.ep} ↔ ${edge.b.tl_id}#${edge.b.ep}`;
                    return (
                      <li
                        key={edge.key}
                        className={`flex items-center gap-2 rounded px-1.5 py-0.5 ${
                          ignored
                            ? "bg-muted/30 text-muted-foreground line-through opacity-60"
                            : STATE_ROW_CLASS[edge.state]
                        }`}
                      >
                        <span
                          className={`inline-block size-2 shrink-0 rounded-full ${
                            ignored ? "bg-muted-foreground/40" : STATE_DOT_CLASS[edge.state]
                          }`}
                        />
                        <span className="flex-1 truncate font-mono">{edgeLabel}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {Math.round(edge.walkBlocks)}b
                        </span>
                        {isUnconfirmed && (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            className="h-5 w-5 shrink-0 text-current opacity-70 hover:opacity-100"
                            onClick={() => handleEnterPreview(edge.key)}
                            title={t("topsMap.markGroupingElk.jumpTo")}
                            aria-label={t("topsMap.markGroupingElk.jumpTo")}
                          >
                            <MapPin className="h-3 w-3" />
                          </Button>
                        )}
                        {isUnconfirmed && (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            className="h-5 w-5 shrink-0 text-current opacity-70 hover:opacity-100"
                            onClick={() => toggleIgnored(edge.key)}
                            title={
                              ignored
                                ? t("topsMap.markGroupingElk.unignore")
                                : t("topsMap.markGroupingElk.ignore")
                            }
                            aria-label={
                              ignored
                                ? t("topsMap.markGroupingElk.unignore")
                                : t("topsMap.markGroupingElk.ignore")
                            }
                          >
                            {ignored ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                          </Button>
                        )}
                        {isConfirmed && (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            className="h-5 w-5 shrink-0 text-current opacity-70 hover:opacity-100"
                            onClick={() =>
                              setReportEdge({
                                key: edge.key,
                                label: edgeLabel,
                              })
                            }
                            title={t("topsMap.reportElkEdge.title")}
                            aria-label={t("topsMap.reportElkEdge.title")}
                          >
                            <Flag className="h-3 w-3" />
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {edges.length > visibleEdges.length && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 w-full text-xs"
                    onClick={() => setShowAllRows(true)}
                  >
                    {t("topsMap.markGroupingElk.showAll", { count: edges.length })}
                  </Button>
                )}
              </div>
            )}

            {/* Legend — matches ElkWalkableSection */}
            <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-sky-400" />
                {t("routePlanner.elk.legendConfirmed")}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
                {t("routePlanner.elk.legendPendingAttest")}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-slate-300 dark:bg-slate-600" />
                {t("routePlanner.elk.legendUnconfirmed")}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-red-400" />
                {t("routePlanner.elk.legendPendingUnattest")}
              </span>
            </div>

            {allDone && (
              <div className="rounded-md border border-emerald-300/60 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-700/40 dark:bg-emerald-950/30 dark:text-emerald-100">
                {t("topsMap.markGroupingElk.allDone")}
              </div>
            )}

            {submitMut.error && (
              <p className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                {t("topsMap.markGroupingElk.submitError", {
                  message:
                    submitMut.error instanceof Error
                      ? submitMut.error.message
                      : String(submitMut.error),
                })}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitMut.isPending}
          >
            {t("topsMap.markGroupingElk.cancel")}
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={stageableCount === 0 || submitMut.isPending || !apiKey}
          >
            {submitMut.isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            {submitMut.isPending
              ? t("topsMap.markGroupingElk.submitting")
              : stageableCount === 0
                ? t("topsMap.markGroupingElk.nothingToAdd")
                : t("topsMap.markGroupingElk.submit", { count: stageableCount })}
          </Button>
        </DialogFooter>
      </DialogContent>
      <ReportElkEdgeDialog
        open={reportEdge != null}
        onOpenChange={(v) => {
          if (!v) setReportEdge(null);
        }}
        edgeKey={reportEdge?.key ?? null}
        edgeLabel={reportEdge?.label}
      />
    </Dialog>
  );
}

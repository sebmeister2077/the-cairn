import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type HeavyComputeStatus,
  adminGetHeavyComputeStatus,
  adminRunHeavyComputeNow,
} from "@/lib/api";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState, useEffect } from "react";

// Bulk-runner UI shown inside the heavy_compute_enabled flag card. Lets an
// admin manually drain the work that piles up while the kill switch is OFF
// (validation worker, match-score worker, and pre-rendering pending preview
// PNGs). Polls /admin/heavy-compute/status every 2 s while a run is active.
export function HeavyComputeRunner() {
  const queryClient = useQueryClient();
  const [active, setActive] = useState(false);

  const status = useQuery<HeavyComputeStatus>({
    queryKey: ["admin-heavy-compute-status"],
    queryFn: adminGetHeavyComputeStatus,
    refetchInterval: active ? 2_000 : false,
    refetchOnWindowFocus: false,
  });

  // Activate polling whenever the backend reports running, deactivate when
  // it stops (so we still grab the final state).
  useEffect(() => {
    if (status.data?.running) setActive(true);
    else if (active && status.data && !status.data.running) {
      // One more refetch after stop to settle final counts, then quiet down.
      const t = setTimeout(() => setActive(false), 2_500);
      return () => clearTimeout(t);
    }
  }, [status.data, active]);

  const runMutation = useMutation({
    mutationFn: adminRunHeavyComputeNow,
    onSuccess: () => {
      setActive(true);
      queryClient.invalidateQueries({ queryKey: ["admin-heavy-compute-status"] });
    },
  });

  const s = status.data;
  const running = s?.running ?? false;
  const progress =
    s && s.previews_total > 0
      ? Math.round(
          ((s.previews_rendered + s.previews_already_cached + s.previews_failed) /
            s.previews_total) *
            100,
        )
      : null;

  return (
    <div className="rounded border p-2 space-y-2 bg-muted/40">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs">
          <p className="font-medium">Run heavy compute now</p>
          <p className="text-muted-foreground">
            Sequentially: revive zombie validations &rarr; spawn validator &rarr; spawn match-score
            worker &rarr; render every missing preview PNG. Bypasses the kill switch. Safe to call
            repeatedly.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending || running}
        >
          {(runMutation.isPending || running) && (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          )}
          {running ? "Running…" : "Run now"}
        </Button>
      </div>

      {runMutation.error && (
        <p className="text-xs text-destructive">{(runMutation.error as Error).message}</p>
      )}

      {s && (s.started_at || running) && (
        <div className="text-[11px] space-y-1 text-muted-foreground">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="text-[10px]">
              validation worker: {s.validation_worker_started ? "spawned" : "not spawned"}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {s.match_score_skipped_reason
                ? `match-score: ${s.match_score_skipped_reason}`
                : `match-score worker: ${s.match_score_worker_started ? "spawned" : "not spawned"}`}
            </Badge>
            {s.validations_revived > 0 && (
              <Badge variant="outline" className="text-[10px]">
                revived {s.validations_revived} zombie row(s)
              </Badge>
            )}
          </div>
          {s.previews_total > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between">
                <span>
                  previews: {s.previews_rendered + s.previews_already_cached}/{s.previews_total} (
                  {s.previews_already_cached} cached, {s.previews_rendered} rendered,{" "}
                  {s.previews_failed} failed)
                </span>
                {progress !== null && <span>{progress}%</span>}
              </div>
              <div className="h-1.5 w-full rounded bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${progress ?? 0}%` }}
                />
              </div>
              {s.current_preview_id && running && (
                <p className="font-mono text-[10px]">rendering {s.current_preview_id}…</p>
              )}
            </div>
          )}
          {s.previews_failures.length > 0 && (
            <details className="text-[10px]">
              <summary className="cursor-pointer text-destructive">
                {s.previews_failures.length} preview failure(s)
              </summary>
              <ul className="list-disc pl-4 space-y-0.5 mt-1">
                {s.previews_failures.slice(0, 10).map((f, i) => (
                  <li key={i} className="font-mono">
                    {f}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {s.error && <p className="text-destructive">drain crashed: {s.error}</p>}
          {s.finished_at && !running && (
            <p>Finished at {new Date(s.finished_at * 1000).toLocaleTimeString()}.</p>
          )}
        </div>
      )}
    </div>
  );
}

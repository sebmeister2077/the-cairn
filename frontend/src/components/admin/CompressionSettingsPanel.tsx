/**
 * CompressionSettingsPanel — admin UI for the zstd compression knobs.
 *
 * Mounted under the ``compress_artefacts`` operational flag card on the
 * AdminFeatureFlagsPage when (and only when) the flag is ON. Exposes:
 *
 * 1. A 1..22 level slider with snap-marker labels (Fast/Balanced/High/Max).
 * 2. A 3-button radio for the thread budget (single / half / all) showing
 *    the resolved CPU thread count next to each.
 * 3. A live preview card (debounced 300ms) that calls
 *    ``/admin/settings/compression/estimate`` against the live combined-DB
 *    size and shows projected ratio + elapsed seconds for the *currently
 *    edited* settings — never the saved ones.
 * 4. A status line showing the most recent background compression run
 *    (kind, ratio, elapsed) plus the eager migration progress bar.
 *
 * The Save button is enabled only when the form is dirty; saving invalidates
 * the React Query cache so the next read returns the fresh value.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  adminEstimateCompression,
  adminGetCompressionMigrationStatus,
  adminGetCompressionSettings,
  adminGetCompressionStatus,
  adminGetSystemCpuInfo,
  adminSetCompressionSettings,
  type CompressionEstimate,
  type CompressionThreadsPreset,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface SnapMarker {
  level: number;
  label: string;
}

const SNAP_MARKERS: SnapMarker[] = [
  { level: 3, label: "Fast" },
  { level: 10, label: "Balanced" },
  { level: 15, label: "High" },
  { level: 22, label: "Max" },
];

function formatBytes(n: number | null | undefined): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function formatSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined) return "—";
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}m ${r.toFixed(0)}s`;
}

export function CompressionSettingsPanel() {
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ["admin", "compression-settings"],
    queryFn: adminGetCompressionSettings,
  });

  const cpuQuery = useQuery({
    queryKey: ["admin", "system-cpu-info"],
    queryFn: adminGetSystemCpuInfo,
    staleTime: Infinity,
  });

  // Local edit state — only flushed to the server on Save.
  const [level, setLevel] = useState<number>(10);
  const [threads, setThreads] = useState<CompressionThreadsPreset>("half");

  useEffect(() => {
    if (settingsQuery.data) {
      setLevel(settingsQuery.data.level);
      setThreads(settingsQuery.data.threads_preset);
    }
  }, [settingsQuery.data]);

  const dirty = useMemo(() => {
    if (!settingsQuery.data) return false;
    return level !== settingsQuery.data.level || threads !== settingsQuery.data.threads_preset;
  }, [level, threads, settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => adminSetCompressionSettings(level, threads),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "compression-settings"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "compression-estimate"] });
    },
  });

  // Debounced live estimate against the live combined-DB size. The query
  // key includes the edited values so a slider drag fires fresh estimates.
  const [debounced, setDebounced] = useState({ level, threads });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebounced({ level, threads }), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [level, threads]);

  const estimateQuery = useQuery<CompressionEstimate>({
    queryKey: ["admin", "compression-estimate", debounced.level, debounced.threads],
    queryFn: () => adminEstimateCompression(debounced.level, debounced.threads),
  });

  const statusQuery = useQuery({
    queryKey: ["admin", "compression-status"],
    queryFn: adminGetCompressionStatus,
    // Poll fast (5 s) while a run finished recently — that's when an
    // operator is most likely watching. Back off to 60 s once the last
    // run is more than 5 minutes old (or there's no history at all) so
    // an idle panel doesn't hammer the endpoint forever.
    refetchInterval: (q) => {
      const finished = q.state.data?.finished_at;
      if (!finished) return 60_000;
      const ageMs = Date.now() - finished * 1000;
      return ageMs < 5 * 60_000 ? 5_000 : 60_000;
    },
    refetchOnWindowFocus: false,
  });

  const migrationQuery = useQuery({
    queryKey: ["admin", "compression-migration-status"],
    queryFn: adminGetCompressionMigrationStatus,
    // Migration only enters ``running`` on an OFF→ON flag flip and can't
    // restart without one. Poll fast while running, slow while we're
    // still waiting for the first row to appear, and stop entirely once
    // the run has reached a terminal state (``done`` / ``error``) — the
    // panel will pick up a fresh run when it remounts or the user
    // manually refetches.
    refetchInterval: (q) => {
      const phase = q.state.data?.phase;
      if (phase === "running") return 2_000;
      if (phase === "done" || phase === "error") return false;
      return 30_000;
    },
    refetchOnWindowFocus: false,
  });

  const cpuCount = cpuQuery.data?.cpu_count ?? 0;
  const presets = cpuQuery.data?.presets;

  return (
    <div className="rounded border p-3 space-y-4 bg-muted/40">
      <div className="text-xs">
        <p className="font-medium">Compression settings</p>
        <p className="text-muted-foreground">
          These knobs apply to all NEW writes (combined-DB sibling, archived per-contribution .db,
          undo replaced.db, weekly backups). Live preview below uses the current combined-DB size.
        </p>
      </div>

      {/* Level slider */}
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <label className="text-xs font-medium" htmlFor="zstd-level">
            Compression level
          </label>
          <span className="text-xs font-mono tabular-nums">
            <span className="text-foreground font-semibold">{level}</span>
            <span className="text-muted-foreground"> / 22</span>
          </span>
        </div>

        {/* Custom-styled slider. The native <input type=range> is layered
            transparently on top of a painted track + thumb so we keep full
            keyboard / screen-reader behaviour but get a themed look that
            doesn't feel like a default OS widget. */}
        <div className="relative h-6 select-none">
          {/* Track background */}
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-muted" />
          {/* Filled portion */}
          <div
            className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-primary transition-[width] duration-75"
            style={{ width: `${((level - 1) / 21) * 100}%` }}
          />
          {/* Snap tick marks */}
          {SNAP_MARKERS.map((m) => {
            const pct = ((m.level - 1) / 21) * 100;
            const passed = level >= m.level;
            return (
              <div
                key={`tick-${m.level}`}
                className={`absolute top-1/2 -translate-y-1/2 w-px h-2.5 rounded-full pointer-events-none ${
                  passed ? "bg-primary/60" : "bg-muted-foreground/40"
                }`}
                style={{ left: `${pct}%` }}
              />
            );
          })}
          {/* Painted thumb (purely visual; the real thumb is the
              transparent native input above it) */}
          <div
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-4 rounded-full bg-background border-2 border-primary shadow-sm pointer-events-none transition-transform duration-75"
            style={{ left: `${((level - 1) / 21) * 100}%` }}
          />
          <input
            id="zstd-level"
            type="range"
            min={1}
            max={22}
            step={1}
            value={level}
            onChange={(e) => setLevel(parseInt(e.target.value, 10))}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer focus-visible:outline-none peer"
            aria-label="Compression level"
          />
          {/* Focus ring drawn on the painted thumb when the native input is keyboard-focused */}
          <div
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-4 rounded-full pointer-events-none ring-2 ring-ring ring-offset-2 ring-offset-background opacity-0 peer-focus-visible:opacity-100 transition-opacity"
            style={{ left: `${((level - 1) / 21) * 100}%` }}
          />
        </div>

        {/* Snap-marker chips */}
        <div className="flex justify-between gap-1">
          {SNAP_MARKERS.map((m) => {
            const active = level === m.level;
            return (
              <button
                key={m.level}
                type="button"
                onClick={() => setLevel(m.level)}
                className={`flex-1 px-2 py-1 rounded-md text-[10px] font-medium border transition-colors ${
                  active
                    ? "bg-primary/10 border-primary text-foreground"
                    : "bg-background border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {m.label}
                <span className="ml-1 font-mono opacity-70">{m.level}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Threads preset */}
      <div className="space-y-2">
        <label className="text-xs font-medium">Thread budget</label>
        <div className="flex flex-wrap gap-2">
          {(["single", "half", "all"] as CompressionThreadsPreset[]).map((opt) => {
            const resolved = presets ? presets[opt] : null;
            const active = threads === opt;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => setThreads(opt)}
                className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background hover:bg-muted"
                }`}
              >
                {opt}
                {resolved !== null && (
                  <span className="ml-1.5 opacity-75">
                    ({resolved} thread{resolved === 1 ? "" : "s"})
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {cpuCount > 0 && (
          <p className="text-[10px] text-muted-foreground">
            Server has {cpuCount} logical CPU{cpuCount === 1 ? "" : "s"}.
          </p>
        )}
      </div>

      {/* Live preview */}
      <div className="rounded border p-2 bg-background space-y-1 text-[11px]">
        <div className="flex items-center justify-between">
          <span className="font-medium">Live preview (current combined DB)</span>
          {estimateQuery.isFetching && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          )}
        </div>
        {estimateQuery.data ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
            <span>Source size:</span>
            <span className="text-right font-mono">
              {formatBytes(estimateQuery.data.db_size_bytes)}
            </span>
            <span>Estimated output:</span>
            <span className="text-right font-mono">
              {formatBytes(estimateQuery.data.estimated_compressed_bytes)}
            </span>
            <span>Estimated ratio:</span>
            <span className="text-right font-mono">
              {(estimateQuery.data.ratio * 100).toFixed(1)}%
            </span>
            <span>Estimated time:</span>
            <span className="text-right font-mono">
              {formatSeconds(estimateQuery.data.estimated_compress_seconds)}
            </span>
            <span>Threads used:</span>
            <span className="text-right font-mono">{estimateQuery.data.threads}</span>
          </div>
        ) : estimateQuery.error ? (
          <p className="text-destructive">{(estimateQuery.error as Error).message}</p>
        ) : (
          <p className="text-muted-foreground">Calculating…</p>
        )}
      </div>

      {/* Save button */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground">
          {dirty ? (
            <span className="text-amber-600 dark:text-amber-400">Unsaved changes</span>
          ) : settingsQuery.data ? (
            <>
              Saved: level {settingsQuery.data.level}, {settingsQuery.data.threads_preset} (
              {settingsQuery.data.resolved_threads} thread
              {settingsQuery.data.resolved_threads === 1 ? "" : "s"})
            </>
          ) : (
            <>Loading…</>
          )}
        </div>
        <Button
          size="sm"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Save
        </Button>
      </div>
      {saveMutation.error && (
        <p className="text-xs text-destructive">{(saveMutation.error as Error).message}</p>
      )}

      {/* Last run + migration */}
      {statusQuery.data && statusQuery.data.kind && (
        <div className="text-[11px] text-muted-foreground border-t pt-2">
          <p className="font-medium text-foreground">Last background run</p>
          <div className="flex flex-wrap gap-1.5 mt-1">
            <Badge variant="outline" className="text-[10px]">
              {statusQuery.data.kind}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {formatBytes(statusQuery.data.input_bytes)} →{" "}
              {formatBytes(statusQuery.data.output_bytes)}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {formatSeconds(statusQuery.data.elapsed_seconds)}
            </Badge>
            {statusQuery.data.error && (
              <Badge variant="destructive" className="text-[10px]">
                {statusQuery.data.error}
              </Badge>
            )}
          </div>
        </div>
      )}

      {migrationQuery.data && migrationQuery.data.phase !== "idle" && (
        <div className="text-[11px] border-t pt-2 space-y-1">
          <p className="font-medium">
            Eager migration: {migrationQuery.data.phase}
            {migrationQuery.data.total > 0 && (
              <span className="font-normal text-muted-foreground">
                {" "}
                —{" "}
                {migrationQuery.data.processed +
                  migrationQuery.data.skipped +
                  migrationQuery.data.failed}
                /{migrationQuery.data.total}
              </span>
            )}
          </p>
          {migrationQuery.data.total > 0 && (
            <div className="h-1.5 w-full rounded bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{
                  width: `${Math.round(
                    ((migrationQuery.data.processed +
                      migrationQuery.data.skipped +
                      migrationQuery.data.failed) /
                      Math.max(1, migrationQuery.data.total)) *
                      100,
                  )}%`,
                }}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline" className="text-[10px]">
              {migrationQuery.data.processed} converted
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {migrationQuery.data.skipped} skipped
            </Badge>
            {migrationQuery.data.failed > 0 && (
              <Badge variant="destructive" className="text-[10px]">
                {migrationQuery.data.failed} failed
              </Badge>
            )}
          </div>
          {migrationQuery.data.error && (
            <p className="text-destructive">{migrationQuery.data.error}</p>
          )}
        </div>
      )}
    </div>
  );
}

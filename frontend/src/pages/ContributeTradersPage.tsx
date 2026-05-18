/**
 * Contribute Traders page.
 *
 * Two independent flows:
 *   - "Chat log" — paste / upload a `client-chat.log` and extract every
 *     ``trader`` waypoint. Submission is server-rate-limited to **one
 *     batch per day** (per account); admins bypass the cap.
 *   - "Manual" — type one trader at a time, choose its type, and submit.
 *     Limit: **15 batches per day**.
 *
 * Both flows post to ``POST /api/contribute-traders``. The viewer (TOPS
 * map overlay) is independently flag-gated and renders nothing if the
 * traders viewer flag is off; the contribute page does not need a
 * viewer to function.
 */

import { useMemo, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FileUpload } from "@/components/FileUpload";
import { Loader2, Trash2, CheckCircle2 } from "lucide-react";
import {
  contributeTraders,
  getMyTraderContributions,
  ApiError,
  type TraderContributionItem,
  type MyTraderContribution,
} from "@/lib/api";
import {
  extractTradersFromChatLog,
  blankTraderCandidate,
  averageInferredConfidence,
} from "@/lib/trader-parser";
import {
  TRADER_TYPES,
  TRADER_TYPE_LABELS,
  TRADER_TYPE_COLORS,
  isTraderType,
  type TraderCandidate,
  type TraderType,
} from "@/lib/trader-types";
import { TRADERS_QUERY_KEY, useTradersOverlay, type TraderMarker } from "@/hooks/useOverlayData";
import { MaintenanceChip } from "@/components/MaintenanceChip";

const MY_TRADERS_QUERY_KEY = ["my-trader-contributions"] as const;

/**
 * Radius (in blocks) used to suppress chat-log candidates that match a
 * trader already present in the public overlay. Mirrors
 * ``_DUPLICATE_RADIUS`` in ``backend/app/routes/contribute_traders.py``
 * so the client filters out the exact same submissions the server would
 * mark as duplicates — saves the user from scrolling through a wall of
 * already-known traders every time they re-upload their chat log.
 */
const KNOWN_TRADER_DEDUPE_RADIUS = 60;

function filterOutKnownTraders(
  candidates: TraderCandidate[],
  existing: readonly TraderMarker[] | undefined,
): { kept: TraderCandidate[]; removed: number } {
  if (!existing || existing.length === 0) {
    return { kept: candidates, removed: 0 };
  }
  const r2 = KNOWN_TRADER_DEDUPE_RADIUS * KNOWN_TRADER_DEDUPE_RADIUS;
  const kept: TraderCandidate[] = [];
  let removed = 0;
  for (const c of candidates) {
    let isKnown = false;
    for (const t of existing) {
      const dx = c.x - t.x;
      const dz = c.z - t.z;
      if (dx * dx + dz * dz <= r2) {
        isKnown = true;
        break;
      }
    }
    if (isKnown) {
      removed += 1;
    } else {
      kept.push(c);
    }
  }
  return { kept, removed };
}

export function ContributeTradersPage() {
  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <Tabs defaultValue="chatlog">
        <TabsList variant="line">
          <TabsTrigger value="chatlog">From chat log</TabsTrigger>
          <TabsTrigger value="manual">Manual entry</TabsTrigger>
        </TabsList>
        <TabsContent value="chatlog" className="pt-2 space-y-4">
          <ChatLogTradersFlow />
          <MyTradersList />
        </TabsContent>
        <TabsContent value="manual" className="pt-2 space-y-4">
          <ManualTraderEntryFlow />
          <MyTradersList />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface TraderEditorRowProps {
  candidate: TraderCandidate;
  onChange: (next: TraderCandidate) => void;
  onRemove: () => void;
  showCoords?: boolean;
  showLabel?: boolean;
}

function TraderEditorRow({
  candidate,
  onChange,
  onRemove,
  showCoords,
  showLabel = true,
}: TraderEditorRowProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border px-2 py-1.5">
      {showLabel && (
        <Input
          className="h-8 flex-1 min-w-48"
          placeholder="Label (e.g. Trader Survival Goods)"
          value={candidate.label}
          onChange={(e) => onChange({ ...candidate, label: e.target.value })}
        />
      )}
      {showCoords && (
        <>
          <Input
            className="h-8 w-24"
            type="number"
            placeholder="x"
            value={Number.isFinite(candidate.x) ? candidate.x : ""}
            onChange={(e) => onChange({ ...candidate, x: Number(e.target.value) })}
          />
          <Input
            className="h-8 w-24"
            type="number"
            placeholder="z"
            value={Number.isFinite(candidate.z) ? candidate.z : ""}
            onChange={(e) => onChange({ ...candidate, z: Number(e.target.value) })}
          />
        </>
      )}
      <select
        className="h-8 rounded border bg-background px-2 text-sm"
        value={candidate.trader_type ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          onChange({
            ...candidate,
            trader_type: isTraderType(v) ? v : null,
          });
        }}
        aria-label="Trader type"
      >
        <option value="">Type…</option>
        {TRADER_TYPES.map((t) => (
          <option key={t} value={t}>
            {TRADER_TYPE_LABELS[t]}
          </option>
        ))}
      </select>
      <span
        aria-hidden
        className="inline-block h-3 w-3 rounded-full border"
        style={{
          backgroundColor: candidate.trader_type
            ? TRADER_TYPE_COLORS[candidate.trader_type]
            : "transparent",
        }}
      />
      <Button variant="ghost" size="sm" aria-label="Remove" onClick={onRemove} type="button">
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

function readyForSubmit(candidates: TraderCandidate[]): TraderCandidate[] {
  return candidates.filter(
    (c) =>
      Number.isFinite(c.x) &&
      Number.isFinite(c.z) &&
      c.trader_type != null &&
      isTraderType(c.trader_type),
  );
}

function toApiItems(candidates: TraderCandidate[]): TraderContributionItem[] {
  return candidates.map((c) => ({
    x: Math.trunc(c.x),
    z: Math.trunc(c.z),
    y: Number.isFinite(c.y) ? Math.trunc(c.y as number) : undefined,
    label: c.label?.trim() || undefined,
    // safe: readyForSubmit filtered out null types
    trader_type: c.trader_type as TraderType,
  }));
}

function formatApiError(e: unknown): string {
  if (e instanceof ApiError) {
    return e.message || `Request failed (${e.status})`;
  }
  if (e instanceof Error) return e.message;
  return "Failed to submit traders";
}

// ---------------------------------------------------------------------------
// Chat-log flow
// ---------------------------------------------------------------------------

function ChatLogTradersFlow() {
  const queryClient = useQueryClient();
  const tradersQuery = useTradersOverlay();
  const knownTraders = tradersQuery.data?.data;
  const [file, setFile] = useState<File | null>(null);
  const [candidates, setCandidates] = useState<TraderCandidate[]>([]);
  const [parsedCount, setParsedCount] = useState(0);
  const [knownFilteredCount, setKnownFilteredCount] = useState(0);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<{
    accepted: number;
    duplicate_flagged_count: number;
  } | null>(null);

  const handleParse = useCallback(async () => {
    if (!file) return;
    setParsing(true);
    setParseError(null);
    setSubmitResult(null);
    try {
      const text = await file.text();
      const out = extractTradersFromChatLog(text);
      const { kept, removed } = filterOutKnownTraders(out.candidates, knownTraders);
      setCandidates(kept);
      setParsedCount(out.parsedWaypointCount);
      setKnownFilteredCount(removed);
      if (out.candidates.length === 0) {
        setParseError(
          "No trader waypoints found in this file. " +
            'Make sure you typed "/waypoint list details" in-game first and ' +
            'that some waypoints use the "trader" icon.',
        );
      } else if (kept.length === 0) {
        setParseError(
          `All ${removed} trader waypoint${removed === 1 ? "" : "s"} in this chat log ` +
            "already match a trader on the map (within " +
            `${KNOWN_TRADER_DEDUPE_RADIUS} blocks). Nothing new to submit.`,
        );
      }
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Failed to parse chat log");
    } finally {
      setParsing(false);
    }
  }, [file, knownTraders]);

  const ready = useMemo(() => readyForSubmit(candidates), [candidates]);

  // Match-percentage stat (mirrors the TL chat-log flow's
  // ``existing_match_pct``): denom = filtered-out known traders + the
  // submittable batch size, numerator = filtered-out known traders. So a
  // chat log that's 100% already-known traders scores 100; a fully fresh
  // batch scores 0. Rounded to 1 decimal.
  const existingMatchPct = useMemo(() => {
    const denom = knownFilteredCount + ready.length;
    if (denom === 0) return 0;
    return Math.round((knownFilteredCount / denom) * 1000) / 10;
  }, [knownFilteredCount, ready.length]);

  const handleSubmit = useCallback(async () => {
    if (ready.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitResult(null);
    try {
      const result = await contributeTraders({
        traders: toApiItems(ready),
        source: "chatlog",
        stats: {
          chatlog_parsed_count: parsedCount,
          inferred_confidence_avg: averageInferredConfidence(candidates),
          existing_match_count: knownFilteredCount,
          existing_match_pct: existingMatchPct,
        },
      });
      setSubmitResult({
        accepted: result.accepted,
        duplicate_flagged_count: result.duplicate_flagged_count,
      });
      setCandidates([]);
      setFile(null);
      setKnownFilteredCount(0);
      queryClient.invalidateQueries({ queryKey: [...TRADERS_QUERY_KEY] });
      queryClient.invalidateQueries({ queryKey: [...MY_TRADERS_QUERY_KEY] });
    } catch (e) {
      setSubmitError(formatApiError(e));
    } finally {
      setSubmitting(false);
    }
  }, [ready, parsedCount, candidates, knownFilteredCount, existingMatchPct, queryClient]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Upload client-chat.log
          <MaintenanceChip component="tops_contribute_traders_log" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          1. In-game, type{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            /waypoint list details
          </code>
          . 2. Save your chat log. 3. Upload it here. We pick out every waypoint whose icon is{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">trader</code>, guess
          the type from the label, and let you review before submission. Limit:{" "}
          <b>one chat-log submission per day</b>.
        </p>
        <FileUpload
          id="trader-chat-log"
          label="client-chat.log"
          accept=".log,.txt,text/plain"
          onChange={setFile}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={handleParse} disabled={!file || parsing}>
            {parsing && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Parse traders
          </Button>
          {parsedCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {parsedCount.toLocaleString()} waypoints scanned ·{" "}
              {candidates.length.toLocaleString()} new trader
              {candidates.length === 1 ? "" : "s"} found
              {knownFilteredCount > 0 && (
                <>
                  {" "}
                  · {knownFilteredCount.toLocaleString()} already on the map (filtered) ·{" "}
                  <b>{existingMatchPct.toFixed(1)}% match</b> with existing traders
                </>
              )}
            </span>
          )}
        </div>
        {parseError && (
          <p className="text-sm text-red-500" role="alert">
            {parseError}
          </p>
        )}
        {candidates.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium">
              Review traders ({ready.length} of {candidates.length} ready)
            </div>
            <div className="space-y-1 max-h-80 overflow-auto">
              {candidates.map((c) => (
                <TraderEditorRow
                  key={c.localId}
                  candidate={c}
                  onChange={(next) =>
                    setCandidates((prev) => prev.map((p) => (p.localId === c.localId ? next : p)))
                  }
                  onRemove={() =>
                    setCandidates((prev) => prev.filter((p) => p.localId !== c.localId))
                  }
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={handleSubmit} disabled={ready.length === 0 || submitting}>
                {submitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                Submit {ready.length} trader{ready.length === 1 ? "" : "s"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Entries missing a type or coordinates are skipped.
              </span>
            </div>
          </div>
        )}
        {submitError && (
          <p className="text-sm text-red-500" role="alert">
            {submitError}
          </p>
        )}
        {submitResult && (
          <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-green-700 dark:text-green-300">
              <CheckCircle2 className="h-4 w-4" />
              Submitted {submitResult.accepted} trader
              {submitResult.accepted === 1 ? "" : "s"}
            </div>
            {submitResult.duplicate_flagged_count > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {submitResult.duplicate_flagged_count} flagged as possible duplicates of nearby
                existing traders; admins will review.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Manual flow
// ---------------------------------------------------------------------------

function ManualTraderEntryFlow() {
  const queryClient = useQueryClient();
  const [candidates, setCandidates] = useState<TraderCandidate[]>([blankTraderCandidate()]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<{
    accepted: number;
    duplicate_flagged_count: number;
  } | null>(null);

  const ready = useMemo(() => readyForSubmit(candidates), [candidates]);

  const handleSubmit = useCallback(async () => {
    if (ready.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitResult(null);
    try {
      const result = await contributeTraders({
        traders: toApiItems(ready),
        source: "manual",
      });
      setSubmitResult({
        accepted: result.accepted,
        duplicate_flagged_count: result.duplicate_flagged_count,
      });
      setCandidates([blankTraderCandidate()]);
      queryClient.invalidateQueries({ queryKey: [...TRADERS_QUERY_KEY] });
      queryClient.invalidateQueries({ queryKey: [...MY_TRADERS_QUERY_KEY] });
    } catch (e) {
      setSubmitError(formatApiError(e));
    } finally {
      setSubmitting(false);
    }
  }, [ready, queryClient]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Add traders manually
          <MaintenanceChip component="tops_contribute_traders_manual" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Enter the in-game world coordinates (x, z) and choose the trader's type. Limit:{" "}
          <b>15 submissions per day</b>. Each Submit button press counts as one submission,
          regardless of how many traders are in the batch.
        </p>
        <div className="space-y-1">
          {candidates.map((c) => (
            <TraderEditorRow
              key={c.localId}
              candidate={c}
              showCoords
              showLabel={false}
              onChange={(next) => {
                // Manual flow: derive the label from the chosen type so
                // the user doesn't have to type it. Re-derive whenever
                // the type changes (including from null -> a value).
                const derivedLabel =
                  next.trader_type && isTraderType(next.trader_type)
                    ? TRADER_TYPE_LABELS[next.trader_type]
                    : "";
                setCandidates((prev) =>
                  prev.map((p) => (p.localId === c.localId ? { ...next, label: derivedLabel } : p)),
                );
              }}
              onRemove={() =>
                setCandidates((prev) =>
                  prev.length === 1
                    ? [blankTraderCandidate()]
                    : prev.filter((p) => p.localId !== c.localId),
                )
              }
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            type="button"
            onClick={() => setCandidates((prev) => [...prev, blankTraderCandidate()])}
          >
            Add row
          </Button>
          <Button onClick={handleSubmit} disabled={ready.length === 0 || submitting}>
            {submitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Submit {ready.length} trader{ready.length === 1 ? "" : "s"}
          </Button>
        </div>
        {submitError && (
          <p className="text-sm text-red-500" role="alert">
            {submitError}
          </p>
        )}
        {submitResult && (
          <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-green-700 dark:text-green-300">
              <CheckCircle2 className="h-4 w-4" />
              Submitted {submitResult.accepted} trader
              {submitResult.accepted === 1 ? "" : "s"}
            </div>
            {submitResult.duplicate_flagged_count > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {submitResult.duplicate_flagged_count} flagged as possible duplicates of nearby
                existing traders; admins will review.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// My traders history
// ---------------------------------------------------------------------------

function MyTradersList() {
  const query = useQuery({
    queryKey: [...MY_TRADERS_QUERY_KEY],
    queryFn: () => getMyTraderContributions({ limit: 100 }),
    staleTime: 30_000,
  });
  const items: MyTraderContribution[] = query.data?.items ?? [];
  const stats = query.data?.stats;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your trader contributions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading && (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
        {query.isError && (
          <p className="text-sm text-red-500">Sign in to view your trader contribution history.</p>
        )}
        {stats && (
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span>
              Total: <b className="text-foreground">{stats.total_added}</b>
            </span>
            <span>
              Last 7 days: <b className="text-foreground">{stats.added_last_7d}</b>
            </span>
            <span>
              Chat log: <b className="text-foreground">{stats.chatlog_added}</b>
            </span>
            <span>
              Manual: <b className="text-foreground">{stats.manual_added}</b>
            </span>
          </div>
        )}
        {items.length === 0 && !query.isLoading && (
          <p className="text-sm text-muted-foreground">You haven't contributed any traders yet.</p>
        )}
        {items.length > 0 && (
          <ul className="space-y-1 text-sm max-h-72 overflow-auto">
            {items.map((r) => {
              const props = (r.after_payload?.properties ?? {}) as {
                label?: string;
                trader_type?: string;
              };
              const coords =
                ((r.after_payload?.geometry ?? {}) as { coordinates?: number[] })?.coordinates ??
                [];
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-2 rounded border px-2 py-1"
                >
                  {r.trader_type && isTraderType(r.trader_type) && (
                    <span
                      aria-hidden
                      className="inline-block h-3 w-3 rounded-full"
                      style={{
                        backgroundColor: TRADER_TYPE_COLORS[r.trader_type],
                      }}
                    />
                  )}
                  <span className="font-medium">{props.label || "(no label)"}</span>
                  {r.trader_type && (
                    <span className="text-xs text-muted-foreground">
                      {TRADER_TYPE_LABELS[r.trader_type as TraderType] ?? r.trader_type}
                    </span>
                  )}
                  {coords.length >= 2 && (
                    <span className="text-xs text-muted-foreground">
                      ({coords[0]}, {-coords[1]})
                    </span>
                  )}
                  {r.duplicate_flagged && (
                    <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                      duplicate?
                    </span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {r.source ?? ""} · {new Date(r.created_at).toLocaleString()}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

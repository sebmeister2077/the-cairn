/**
 * Manual TL entry flow.
 *
 * Each row has two endpoint coordinate inputs (x1/z1 and x2/z2) and an
 * optional Y depth per endpoint (y1/y2 → stored as `depth1`/`depth2`
 * on the geojson feature; defaults to 0 when blank). Submissions are
 * instant — the backend appends them to the live translocators.geojson
 * without admin review, gated by the `manual_translocators` feature
 * flag.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Trash2, CheckCircle2, Clipboard, ClipboardCheck } from "lucide-react";
import { ApiError, contributeTLsManual } from "@/lib/api";
import { MaintenanceChip } from "@/components/MaintenanceChip";
import { TRANSLOCATORS_QUERY_KEY } from "@/hooks/useOverlayData";
import { useTranslation } from "@/lib/i18n";

interface ManualTLCandidate {
  localId: string;
  x1: number;
  z1: number;
  y1: number;
  x2: number;
  z2: number;
  y2: number;
}

function blankCandidate(): ManualTLCandidate {
  return {
    localId:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `tl-${Math.random().toString(36).slice(2, 10)}`,
    x1: NaN,
    z1: NaN,
    y1: NaN,
    x2: NaN,
    z2: NaN,
    y2: NaN,
  };
}

function isReady(c: ManualTLCandidate): boolean {
  if (![c.x1, c.z1, c.x2, c.z2].every((n) => Number.isFinite(n))) return false;
  if (c.x1 === c.x2 && c.z1 === c.z2) return false;
  return true;
}

/**
 * Signed-integer coordinate input with a local text buffer so the user
 * can backspace down to empty (or just "-") mid-edit without the
 * parent's numeric state snapping the field back. Same pattern as the
 * trader page's CoordInput.
 */
function CoordInput({
  value,
  placeholder,
  onChange,
  width = "w-20",
}: {
  value: number;
  placeholder: string;
  onChange: (n: number) => void;
  width?: string;
}) {
  const [text, setText] = useState(() => (Number.isFinite(value) ? String(value) : ""));
  useEffect(() => {
    const parsed = text === "" || text === "-" ? NaN : Number(text);
    const same = Number.isFinite(value) && Number.isFinite(parsed) && parsed === value;
    if (!same && Number.isFinite(value) && String(value) !== text) {
      setText(String(value));
    } else if (!Number.isFinite(value) && text !== "" && text !== "-") {
      setText("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Input
      className={`h-8 ${width}`}
      inputMode="numeric"
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        const v = e.target.value;
        if (v !== "" && v !== "-" && !/^-?\d+$/.test(v)) return;
        setText(v);
        const parsed = v === "" || v === "-" ? NaN : Number(v);
        onChange(parsed);
      }}
    />
  );
}

export function ManualTLEntryFlow() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [candidates, setCandidates] = useState<ManualTLCandidate[]>([blankCandidate()]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<{
    accepted: number;
    skipped_existing: number;
    commands: string[];
  } | null>(null);
  const [copiedIndexes, setCopiedIndexes] = useState<number[]>([]);

  const ready = useMemo(() => candidates.filter(isReady), [candidates]);

  const updateField = useCallback((localId: string, patch: Partial<ManualTLCandidate>) => {
    setCandidates((prev) => prev.map((p) => (p.localId === localId ? { ...p, ...patch } : p)));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (ready.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitResult(null);
    try {
      const result = await contributeTLsManual({
        translocators: ready.map((c) => ({
          x1: c.x1,
          z1: c.z1,
          x2: c.x2,
          z2: c.z2,
          y1: Number.isFinite(c.y1) ? c.y1 : undefined,
          y2: Number.isFinite(c.y2) ? c.y2 : undefined,
        })),
      });
      setSubmitResult({
        accepted: result.accepted,
        skipped_existing: result.skipped_existing ?? 0,
        commands: ready.flatMap((c) => {
          const y1 = Number.isFinite(c.y1) ? c.y1 : 1;
          const y2 = Number.isFinite(c.y2) ? c.y2 : 1;
          return [
            `/waypoint addati spiral ${c.x1} ${y1} ${c.z1} false purple TL to ${c.x2} ${c.z2}`,
            `/waypoint addati spiral ${c.x2} ${y2} ${c.z2} false purple TL to ${c.x1} ${c.z1}`,
          ];
        }),
      });
      setCopiedIndexes([]);
      setCandidates([blankCandidate()]);
      queryClient.invalidateQueries({ queryKey: TRANSLOCATORS_QUERY_KEY });
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        if (e.status === 503) {
          setSubmitError(t("contributeTLsPage.manual.disabled"));
        } else if (e.status === 403) {
          setSubmitError(t("contributeTLsPage.manual.needsAccount"));
        } else if (e.status === 429) {
          setSubmitError(t("contributeTLsPage.manual.rateLimited"));
        } else {
          setSubmitError(e.message || t("contributeTLsPage.manual.submitFailed"));
        }
      } else {
        setSubmitError(e instanceof Error ? e.message : t("contributeTLsPage.manual.submitFailed"));
      }
    } finally {
      setSubmitting(false);
    }
  }, [ready, queryClient, t]);

  const handleCopyCommand = useCallback(
    async (index: number) => {
      const cmd = submitResult?.commands[index];
      if (!cmd) return;
      try {
        await navigator.clipboard.writeText(cmd);
        setCopiedIndexes((arr) => [...arr, index]);
        // window.setTimeout(() => {
        //   setCopiedIndexes((cur) => (cur[0] === index ? [] : cur));
        // }, 2000);
      } catch {
        // Clipboard write can fail in insecure contexts; ignore.
      }
    },
    [submitResult],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t("contributeTLsPage.manual.title")}
          <MaintenanceChip component="tops_contribute_tls_manual" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("contributeTLsPage.manual.descriptionPrefix")}{" "}
          <b>{t("contributeTLsPage.manual.descriptionLimit")}</b>
          {t("contributeTLsPage.manual.descriptionSuffix")}
        </p>
        <div className="space-y-1">
          {candidates.map((c) => (
            <div
              key={c.localId}
              className="flex flex-wrap items-center gap-2 rounded border px-2 py-1.5"
            >
              <span className="text-xs text-muted-foreground">A:</span>
              <CoordInput
                value={c.x1}
                placeholder="x1"
                onChange={(n) => updateField(c.localId, { x1: n })}
              />
              <CoordInput
                value={c.y1}
                placeholder={t("contributeTLsPage.manual.yPlaceholder")}
                onChange={(n) => updateField(c.localId, { y1: n })}
                width="w-16"
              />
              <CoordInput
                value={c.z1}
                placeholder="z1"
                onChange={(n) => updateField(c.localId, { z1: n })}
              />
              <span className="text-xs text-muted-foreground">B:</span>
              <CoordInput
                value={c.x2}
                placeholder="x2"
                onChange={(n) => updateField(c.localId, { x2: n })}
              />
              <CoordInput
                value={c.y2}
                placeholder={t("contributeTLsPage.manual.yPlaceholder")}
                onChange={(n) => updateField(c.localId, { y2: n })}
                width="w-16"
              />
              <CoordInput
                value={c.z2}
                placeholder="z2"
                onChange={(n) => updateField(c.localId, { z2: n })}
              />
              <Button
                variant="ghost"
                size="sm"
                type="button"
                aria-label={t("contributeTLsPage.manual.remove")}
                onClick={() =>
                  setCandidates((prev) =>
                    prev.length === 1
                      ? [blankCandidate()]
                      : prev.filter((p) => p.localId !== c.localId),
                  )
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            type="button"
            onClick={() => setCandidates((prev) => [...prev, blankCandidate()])}
          >
            {t("contributeTLsPage.manual.addRow")}
          </Button>
          <Button onClick={handleSubmit} disabled={ready.length === 0 || submitting}>
            {submitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {t("contributeTLsPage.manual.submitButton", {
              count: ready.length,
              suffix: ready.length === 1 ? "" : "s",
            })}
          </Button>
        </div>
        {submitError && (
          <p className="text-sm text-red-500" role="alert">
            {submitError}
          </p>
        )}
        {submitResult && (
          <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm space-y-2">
            <div className="flex items-center gap-2 font-medium text-green-700 dark:text-green-300">
              <CheckCircle2 className="h-4 w-4" />
              {t("contributeTLsPage.manual.submitted", {
                count: submitResult.accepted,
                suffix: submitResult.accepted === 1 ? "" : "s",
              })}
            </div>
            {submitResult.skipped_existing > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("contributeTLsPage.manual.skippedExisting", {
                  count: submitResult.skipped_existing,
                })}
              </p>
            )}
            {submitResult.commands.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium">
                  {t("contributeTLsPage.manual.waypointCommandsTitle")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("contributeTLsPage.manual.waypointCommandsHelp")}
                </p>
                <ul className="space-y-1">
                  {submitResult.commands.map((cmd, i) => (
                    <li
                      key={i}
                      className="flex items-center gap-2 rounded border bg-background p-1.5"
                    >
                      <code className="flex-1 overflow-x-auto whitespace-nowrap text-xs">
                        {cmd}
                      </code>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleCopyCommand(i)}
                        aria-label={
                          copiedIndexes.includes(i)
                            ? t("contributeTLsPage.manual.copied")
                            : t("contributeTLsPage.manual.copyCommand")
                        }
                      >
                        {copiedIndexes.includes(i) ? (
                          <ClipboardCheck className="size-4" />
                        ) : (
                          <Clipboard className="size-4" />
                        )}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

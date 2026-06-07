// Per-segment pattern editor. The selected segment's mode + pattern
// drive the existing controls; switching the segment selector swaps
// which edge the controls operate on.
//
// All per-mode UI (stepped step ratios, sequence input, padding,
// breakdown) is preserved from the single-tunnel version — only the
// data plumbing changed.

import { useMemo, useState } from "react";
import { Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/lib/i18n";
import {
  autoFitPattern,
  formatTokens,
  parseSequenceTokens,
  summarizePathPattern,
  TUNNEL_MODES,
  type Axis,
  type TunnelMode,
  type TunnelPattern,
} from "@/lib/tunnel-pattern";
import { HUB_ID, type EdgeKey, type MultiSegment, type SegmentSpec } from "@/lib/tunnel-multi";
import type { TLEndpoint } from "@/lib/tunnel-multi";
import { JUNCTION_COLOR, SEGMENT_BLOCK_FALLBACK, endpointColor } from "@/lib/tunnel-colors";

import { IntegerField } from "./IntegerField";

interface PatternCardProps {
  segments: MultiSegment[];
  endpoints: TLEndpoint[];
  selectedEdge: EdgeKey | null;
  onChangeSelectedEdge: (key: EdgeKey) => void;
  onChangeSegment: (key: EdgeKey, spec: SegmentSpec) => void;
}

const AXES: Axis[] = ["x", "y", "z"];

function segmentLabel(
  seg: MultiSegment,
  byId: Map<string, TLEndpoint>,
  fallbackHub: string,
): string {
  const aLabel = byId.get(seg.fromId)?.label || seg.fromId;
  const bLabel = seg.toId === HUB_ID ? fallbackHub : byId.get(seg.toId)?.label || seg.toId;
  return `${aLabel} → ${bLabel}`;
}

/** Color used to highlight the segment in the 3D scene. Hub branches
 *  inherit the owning endpoint's color; pair / tour segments share the
 *  neutral fallback the renderer uses. Keeping this in sync with
 *  `TunnelScene.segmentTint` is intentional. */
function segmentSwatch(seg: MultiSegment, idxByEpId: Map<string, number>): string {
  if (seg.toId === HUB_ID) {
    const idx = idxByEpId.get(seg.fromId);
    if (idx !== undefined) return endpointColor(idx);
    return JUNCTION_COLOR;
  }
  return SEGMENT_BLOCK_FALLBACK;
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-3 w-3 shrink-0 rounded-sm ring-1 ring-foreground/20"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );
}

export function PatternCard({
  segments,
  endpoints,
  selectedEdge,
  onChangeSelectedEdge,
  onChangeSegment,
}: PatternCardProps) {
  const { t } = useTranslation();

  const byId = useMemo(() => new Map(endpoints.map((e) => [e.id, e])), [endpoints]);
  const idxByEpId = useMemo(() => {
    const m = new Map<string, number>();
    endpoints.forEach((e, i) => m.set(e.id, i));
    return m;
  }, [endpoints]);
  const active = useMemo(
    () => segments.find((s) => s.key === selectedEdge) ?? segments[0] ?? null,
    [segments, selectedEdge],
  );

  const hubLabel = t("tools.tunnel.hubMarker");
  const segmentOptions = useMemo(() => {
    return segments.map((s, i) => ({
      key: s.key,
      label: segmentLabel(s, byId, hubLabel),
      color: segmentSwatch(s, idxByEpId),
      index: i + 1,
    }));
  }, [segments, byId, hubLabel, idxByEpId]);

  if (!active) {
    return (
      <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
        {t("tools.tunnel.noActiveSegment")}
      </div>
    );
  }

  const { spec, fromCoord, toCoord, path, key } = active;
  const mode = spec.mode;
  const pattern = spec.pattern;
  const isStepped = mode === "stepped";
  const isSequence = mode === "sequence";

  const setMode = (next: TunnelMode) => onChangeSegment(key, { ...spec, mode: next });
  const setPattern = (next: TunnelPattern) => onChangeSegment(key, { ...spec, pattern: next });
  const handleAutoFit = () =>
    onChangeSegment(key, { ...spec, pattern: autoFitPattern(fromCoord, toCoord) });

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <div className="space-y-1.5">
        <h2 className="text-sm font-semibold">{t("tools.tunnel.sectionPattern")}</h2>
        {segments.length > 1 && (
          <div className="space-y-1">
            <Label
              htmlFor="tunnel-segment-selector"
              className="text-[10px] uppercase tracking-wide text-muted-foreground"
            >
              {t("tools.tunnel.segmentSelectorLabel")}
            </Label>
            <Select value={key} onValueChange={(v) => onChangeSelectedEdge(v as EdgeKey)}>
              <SelectTrigger id="tunnel-segment-selector" size="sm" className="w-full">
                <SelectValue>
                  <span className="flex items-center gap-2">
                    <Swatch
                      color={
                        segmentOptions.find((o) => o.key === key)?.color ?? SEGMENT_BLOCK_FALLBACK
                      }
                    />
                    <span className="truncate">
                      {segmentOptions.find((o) => o.key === key)?.label ?? key}
                    </span>
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {segmentOptions.map((o) => (
                  <SelectItem key={o.key} value={o.key}>
                    <span className="flex items-center gap-2">
                      <Swatch color={o.color} />
                      <span className="text-muted-foreground">#{o.index}</span> {o.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <fieldset className="space-y-1">
        <legend className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("tools.tunnel.modeLabel")}
        </legend>
        <div className="grid grid-cols-2 gap-2">
          {TUNNEL_MODES.map((m) => (
            <label
              key={m}
              className="flex cursor-pointer items-center gap-2 rounded border bg-background px-2 py-1.5 text-xs hover:bg-muted has-checked:border-primary has-checked:bg-primary/10"
            >
              <input
                type="radio"
                name={`tunnel-mode-${key}`}
                value={m}
                checked={mode === m}
                onChange={() => setMode(m)}
                className="sr-only"
              />
              <span className="flex-1 font-medium">{t(`tools.tunnel.modes.${m}`)}</span>
            </label>
          ))}
        </div>
        <p className="text-[10px] h-6 text-muted-foreground">
          {t(`tools.tunnel.modeHints.${mode}`)}
        </p>
      </fieldset>

      {isStepped && (
        <SteppedSection pattern={pattern} onChange={setPattern} onAutoFit={handleAutoFit} />
      )}

      {isSequence && <SequenceSection pattern={pattern} onChange={setPattern} />}

      <div className="space-y-1 border-t border-border/60 pt-2">
        <IntegerField
          id={`tunnel-padding-${key}`}
          label={t("tools.tunnel.paddingLabel")}
          value={pattern.padding}
          onChange={(padding) => setPattern({ ...pattern, padding })}
          min={0}
          max={64}
        />
        <p className="text-[10px] text-muted-foreground">{t("tools.tunnel.paddingHint")}</p>
        <div className="mt-2 flex items-start gap-2 rounded border bg-background px-2 py-1.5 text-xs">
          <Switch
            id={`tunnel-padding-diagonal-${key}`}
            checked={pattern.paddingDiagonal}
            onCheckedChange={(checked) => setPattern({ ...pattern, paddingDiagonal: checked })}
            className="mt-0.5"
          />
          <Label
            htmlFor={`tunnel-padding-diagonal-${key}`}
            className="flex-1 cursor-pointer flex-col items-start gap-0.5"
          >
            <span className="font-medium">{t("tools.tunnel.paddingDiagonalLabel")}</span>
            <span className="text-[10px] font-normal text-muted-foreground">
              {t("tools.tunnel.paddingDiagonalHint")}
            </span>
          </Label>
        </div>
        <div className="flex items-start gap-2 rounded border bg-background px-2 py-1.5 text-xs">
          <Switch
            id={`tunnel-use-slabs-${key}`}
            checked={pattern.useSlabs}
            onCheckedChange={(checked) => setPattern({ ...pattern, useSlabs: checked })}
            className="mt-0.5"
          />
          <Label
            htmlFor={`tunnel-use-slabs-${key}`}
            className="flex-1 cursor-pointer flex-col items-start gap-0.5"
          >
            <span className="font-medium">{t("tools.tunnel.useSlabsLabel")}</span>
            <span className="text-[10px] font-normal text-muted-foreground">
              {t("tools.tunnel.useSlabsHint")}
            </span>
          </Label>
        </div>
      </div>

      {!isSequence && path.length > 1 && (
        <BreakdownDetails path={path} fromCoord={fromCoord} toCoord={toCoord} />
      )}
    </div>
  );
}

function SteppedSection({
  pattern,
  onChange,
  onAutoFit,
}: {
  pattern: TunnelPattern;
  onChange: (next: TunnelPattern) => void;
  onAutoFit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex items-end justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("tools.tunnel.steppedSection")}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAutoFit}
          title={t("tools.tunnel.autoFitTitle")}
          className="shrink-0"
        >
          <Wand2 className="mr-1 h-3 w-3" />
          {t("tools.tunnel.autoFit")}
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <IntegerField
          id="tunnel-step-x"
          label={t("tools.tunnel.stepX")}
          value={pattern.stepX}
          onChange={(stepX) => onChange({ ...pattern, stepX })}
        />
        <IntegerField
          id="tunnel-step-y"
          label={t("tools.tunnel.stepY")}
          value={pattern.stepY}
          onChange={(stepY) => onChange({ ...pattern, stepY })}
        />
        <IntegerField
          id="tunnel-step-z"
          label={t("tools.tunnel.stepZ")}
          value={pattern.stepZ}
          onChange={(stepZ) => onChange({ ...pattern, stepZ })}
        />
      </div>
      <fieldset className="space-y-1">
        <legend className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("tools.tunnel.primaryAxis")}
        </legend>
        <div className="flex gap-2">
          {AXES.map((ax) => (
            <label
              key={ax}
              className="flex flex-1 cursor-pointer items-center justify-center gap-1 rounded border bg-background px-2 py-1 text-xs hover:bg-muted has-checked:border-primary has-checked:bg-primary/10"
            >
              <input
                type="radio"
                name="tunnel-primary-axis"
                value={ax}
                checked={pattern.primaryAxis === ax}
                onChange={() => onChange({ ...pattern, primaryAxis: ax })}
                className="sr-only"
              />
              <span className="font-mono uppercase">{ax}</span>
            </label>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground">{t("tools.tunnel.primaryAxisHint")}</p>
      </fieldset>
    </>
  );
}

function SequenceSection({
  pattern,
  onChange,
}: {
  pattern: TunnelPattern;
  onChange: (next: TunnelPattern) => void;
}) {
  const { t } = useTranslation();
  const parsedTokens = useMemo(() => parseSequenceTokens(pattern.sequence), [pattern.sequence]);
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label
          htmlFor="tunnel-sequence"
          className="text-[10px] uppercase tracking-wide text-muted-foreground"
        >
          {t("tools.tunnel.sequenceLabel")}
        </Label>
        <Input
          id="tunnel-sequence"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={pattern.sequence}
          placeholder={t("tools.tunnel.sequencePlaceholder")}
          onChange={(e) => onChange({ ...pattern, sequence: e.currentTarget.value })}
          className="h-8 font-mono text-sm"
        />
        <p className="text-[10px] text-muted-foreground">{t("tools.tunnel.sequenceHint")}</p>
      </div>

      <div className="rounded border border-border/60 bg-muted/30 p-2 text-[10px] leading-relaxed text-muted-foreground">
        <div className="mb-1 font-semibold uppercase tracking-wide">
          {t("tools.tunnel.sequenceLegendTitle")}
        </div>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          {(["F", "B", "L", "R", "U", "D"] as const).map((d) => (
            <li key={d}>
              <span className="font-mono font-semibold text-foreground">{d}</span>{" "}
              {t(`tools.tunnel.sequenceLegend.${d}`)}
            </li>
          ))}
        </ul>
      </div>

      <div className="text-[10px] text-muted-foreground">
        {parsedTokens.length === 0 ? (
          <span className="text-amber-600 dark:text-amber-400">
            {t("tools.tunnel.sequenceEmpty")}
          </span>
        ) : (
          <span>
            {t("tools.tunnel.sequenceParsed")}{" "}
            <span className="font-mono text-foreground">
              {parsedTokens.map((tk) => `${tk.count}${tk.dir}`).join(" ")}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

function BreakdownDetails({
  path,
  fromCoord,
  toCoord,
}: {
  path: MultiSegment["path"];
  fromCoord: MultiSegment["fromCoord"];
  toCoord: MultiSegment["toCoord"];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const summary = useMemo(
    () => (open ? summarizePathPattern(path, fromCoord, toCoord) : null),
    [open, path, fromCoord, toCoord],
  );
  return (
    <details
      className="border-t border-border/60 pt-2 group"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground select-none">
        {t("tools.tunnel.breakdownToggle")}
      </summary>
      {summary && summary.tokens.length > 0 && (
        <div className="mt-2 space-y-1.5 text-[11px]">
          <div className="font-mono leading-relaxed wrap-break-word max-h-60 overflow-auto">
            {summary.leading.length > 0 && (
              <span className="text-muted-foreground">{formatTokens(summary.leading)} </span>
            )}
            {summary.phases.map((phase, i) => (
              <span key={i}>
                {i > 0 && " "}
                {phase.kind === "cycle" ? (
                  <span className="text-foreground">
                    ({formatTokens(phase.cycle)})
                    <span className="text-muted-foreground"> ×{phase.repeats}</span>
                  </span>
                ) : (
                  <span className="text-amber-600 dark:text-amber-400">
                    {formatTokens(phase.tokens)}
                  </span>
                )}
              </span>
            ))}
            {summary.trailing.length > 0 && (
              <span className="text-muted-foreground"> {formatTokens(summary.trailing)}</span>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {summary.hasCycle
              ? t("tools.tunnel.breakdownCycleHint")
              : t("tools.tunnel.breakdownNoCycleHint")}
          </p>
        </div>
      )}
    </details>
  );
}

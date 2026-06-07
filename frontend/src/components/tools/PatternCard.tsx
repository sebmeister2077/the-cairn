// Step-pattern controls: tunnel mode selector + per-axis step count
// + primary-axis radio + auto-fit. The per-axis fields and primary
// radio are only visible in `"stepped"` mode — the other modes derive
// their geometry directly from the endpoints.

import { useMemo, useState } from "react";
import { Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/lib/i18n";
import type { Axis, TunnelMode, TunnelPattern } from "@/lib/tunnel-pattern";
import {
  formatTokens,
  parseSequenceTokens,
  summarizePathPattern,
  TUNNEL_MODES,
} from "@/lib/tunnel-pattern";
import type { Block3 } from "@/lib/tunnel-share";

import { IntegerField } from "./IntegerField";

interface PatternCardProps {
  mode: TunnelMode;
  pattern: TunnelPattern;
  path: Block3[];
  from: Block3;
  to: Block3;
  onChangeMode: (next: TunnelMode) => void;
  onChange: (next: TunnelPattern) => void;
  onAutoFit: () => void;
}

const AXES: Axis[] = ["x", "y", "z"];

export function PatternCard({
  mode,
  pattern,
  path,
  from,
  to,
  onChangeMode,
  onChange,
  onAutoFit,
}: PatternCardProps) {
  const { t } = useTranslation();
  const isStepped = mode === "stepped";
  const isSequence = mode === "sequence";

  const parsedTokens = useMemo(
    () => (isSequence ? parseSequenceTokens(pattern.sequence) : []),
    [isSequence, pattern.sequence],
  );

  const [breakdownOpen, setBreakdownOpen] = useState(false);
  // Phase detection walks the whole path — only run it when the user
  // actually opens the disclosure, otherwise we'd recompute on every
  // slider tick for a (potentially) thousands-long path.
  const summary = useMemo(
    () => (breakdownOpen && !isSequence ? summarizePathPattern(path, from, to) : null),
    [breakdownOpen, isSequence, path, from, to],
  );

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <div className="space-y-1.5">
        <h2 className="text-sm font-semibold">{t("tools.tunnel.sectionPattern")}</h2>
        <ul className="ml-3 list-disc space-y-0.5 text-xs text-muted-foreground marker:text-muted-foreground/70">
          {TUNNEL_MODES.map((m) => (
            <li key={m}>
              <span className="font-medium text-foreground">{t(`tools.tunnel.modes.${m}`)}</span>
              {": "}
              {t(`tools.tunnel.modeBullets.${m}`)}
            </li>
          ))}
        </ul>
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
                name="tunnel-mode"
                value={m}
                checked={mode === m}
                onChange={() => onChangeMode(m)}
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
      )}

      {isSequence && (
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
              <li>
                <span className="font-mono font-semibold text-foreground">F</span>{" "}
                {t("tools.tunnel.sequenceLegend.F")}
              </li>
              <li>
                <span className="font-mono font-semibold text-foreground">B</span>{" "}
                {t("tools.tunnel.sequenceLegend.B")}
              </li>
              <li>
                <span className="font-mono font-semibold text-foreground">L</span>{" "}
                {t("tools.tunnel.sequenceLegend.L")}
              </li>
              <li>
                <span className="font-mono font-semibold text-foreground">R</span>{" "}
                {t("tools.tunnel.sequenceLegend.R")}
              </li>
              <li>
                <span className="font-mono font-semibold text-foreground">U</span>{" "}
                {t("tools.tunnel.sequenceLegend.U")}
              </li>
              <li>
                <span className="font-mono font-semibold text-foreground">D</span>{" "}
                {t("tools.tunnel.sequenceLegend.D")}
              </li>
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
      )}

      <div className="space-y-1 border-t border-border/60 pt-2">
        <IntegerField
          id="tunnel-padding"
          label={t("tools.tunnel.paddingLabel")}
          value={pattern.padding}
          onChange={(padding) => onChange({ ...pattern, padding })}
          min={0}
          max={64}
        />
        <p className="text-[10px] text-muted-foreground">{t("tools.tunnel.paddingHint")}</p>
        <div className="mt-2 flex items-start gap-2 rounded border bg-background px-2 py-1.5 text-xs">
          <Switch
            id="tunnel-padding-diagonal"
            checked={pattern.paddingDiagonal}
            onCheckedChange={(checked) => onChange({ ...pattern, paddingDiagonal: checked })}
            className="mt-0.5"
          />
          <Label
            htmlFor="tunnel-padding-diagonal"
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
            id="tunnel-use-slabs"
            checked={pattern.useSlabs}
            onCheckedChange={(checked) => onChange({ ...pattern, useSlabs: checked })}
            className="mt-0.5"
          />
          <Label
            htmlFor="tunnel-use-slabs"
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
        <details
          className="border-t border-border/60 pt-2 group"
          onToggle={(e) => setBreakdownOpen(e.currentTarget.open)}
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
      )}
    </div>
  );
}

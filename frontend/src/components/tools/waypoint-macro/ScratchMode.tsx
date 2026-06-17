// Generate-from-scratch mode: build a list of commands from templates such as
// bulk-remove-by-range, remove-one, and a custom command looped over a range.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, X } from "lucide-react";
import { buildBulkRemoveCommands, removeCommand } from "@/lib/waypoint-macro";
import { CommandCatalog } from "./CommandCatalog";

type StepKind = "bulkRemove" | "removeOne" | "loop";

interface BulkRemoveStep {
  id: string;
  kind: "bulkRemove";
  start: number;
  end: number;
}
interface RemoveOneStep {
  id: string;
  kind: "removeOne";
  targetId: number;
}
interface LoopStep {
  id: string;
  kind: "loop";
  start: number;
  end: number;
  template: string;
}

type Step = BulkRemoveStep | RemoveOneStep | LoopStep;

/** Max commands a single loop step may emit, as a safety bound. */
const LOOP_MAX_ITERATIONS = 10000;

let stepSeq = 0;
function newStepId(): string {
  stepSeq += 1;
  return `s${Date.now().toString(36)}_${stepSeq}`;
}

function makeStep(kind: StepKind): Step {
  const id = newStepId();
  switch (kind) {
    case "bulkRemove":
      return { id, kind, start: 0, end: 99 };
    case "removeOne":
      return { id, kind, targetId: 0 };
    case "loop":
      return { id, kind, start: 0, end: 9, template: "/waypoint remove {i}" };
  }
}

/** Expand a loop template over [start, end] (inclusive), replacing {i}. */
function expandLoop(step: LoopStep): string[] {
  const { start, end, template } = step;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const step1 = end >= start ? 1 : -1;
  const count = Math.abs(end - start) + 1;
  if (count > LOOP_MAX_ITERATIONS) return [];
  const out: string[] = [];
  for (let i = start; step1 > 0 ? i <= end : i >= end; i += step1) {
    out.push(template.replaceAll("{i}", String(i)));
  }
  return out;
}

function stepCommands(step: Step): string[] {
  switch (step.kind) {
    case "bulkRemove":
      return buildBulkRemoveCommands(step.start, step.end);
    case "removeOne":
      return [removeCommand(step.targetId)];
    case "loop":
      return expandLoop(step);
  }
}

interface ScratchModeProps {
  onCommandsChange: (commands: string[]) => void;
}

export function ScratchMode({ onCommandsChange }: ScratchModeProps) {
  const [steps, setSteps] = useState<Step[]>([]);

  function add(kind: StepKind) {
    setSteps((prev) => [...prev, makeStep(kind)]);
  }
  function update(id: string, patch: Partial<Step>) {
    setSteps((prev) => prev.map((s) => (s.id === id ? ({ ...s, ...patch } as Step) : s)));
  }
  function remove(id: string) {
    setSteps((prev) => prev.filter((s) => s.id !== id));
  }

  const commands = useMemo(() => steps.flatMap(stepCommands), [steps]);
  useEffect(() => onCommandsChange(commands), [commands, onCommandsChange]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Generate from scratch</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Add step</span>
            <Button type="button" variant="outline" size="sm" onClick={() => add("bulkRemove")}>
              <Plus className="size-3.5" /> Bulk remove range
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => add("removeOne")}>
              <Plus className="size-3.5" /> Remove one
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => add("loop")}>
              <Plus className="size-3.5" /> Loop custom command
            </Button>
          </div>

          {steps.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No steps yet. Add one above — e.g. "Bulk remove range" 0–99 generates one
              <code className="mx-1 rounded bg-muted px-1">/waypoint remove 0</code> per waypoint
              (ids auto-shift down as each is removed).
            </p>
          )}

          <div className="space-y-2">
            {steps.map((step) => (
              <div key={step.id} className="rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium">{stepTitle(step.kind)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => remove(step.id)}
                    aria-label="Remove step"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
                <StepFields step={step} update={(patch) => update(step.id, patch)} />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <CommandCatalog />
    </div>
  );
}

function stepTitle(kind: StepKind): string {
  switch (kind) {
    case "bulkRemove":
      return "Bulk remove range";
    case "removeOne":
      return "Remove one";
    case "loop":
      return "Loop custom command";
  }
}

function Num({
  label,
  value,
  onChange,
  width = "w-24",
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  width?: string;
}) {
  return (
    <div className="grid gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type="number"
        className={width}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function StepFields({ step, update }: { step: Step; update: (patch: Partial<Step>) => void }) {
  switch (step.kind) {
    case "bulkRemove":
      return (
        <div className="flex flex-wrap items-end gap-3">
          <Num label="Start id" value={step.start} onChange={(n) => update({ start: n })} />
          <Num label="End id" value={step.end} onChange={(n) => update({ end: n })} />
          <p className="self-center text-xs text-muted-foreground">
            Generates {Math.max(0, Math.abs(step.end - step.start) + 1)} remove command(s).
          </p>
        </div>
      );
    case "removeOne":
      return (
        <div className="flex flex-wrap items-end gap-3">
          <Num
            label="Waypoint id"
            value={step.targetId}
            onChange={(n) => update({ targetId: n })}
          />
        </div>
      );
    case "loop": {
      const count = Math.max(0, Math.abs(step.end - step.start) + 1);
      const tooMany = count > LOOP_MAX_ITERATIONS;
      const preview = expandLoop(step);
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Num label="From (i)" value={step.start} onChange={(n) => update({ start: n })} />
            <Num label="To (i)" value={step.end} onChange={(n) => update({ end: n })} />
            <p className="self-center text-xs text-muted-foreground">
              {tooMany
                ? `Too many iterations (${count}). Max ${LOOP_MAX_ITERATIONS}.`
                : `Repeats ${count} time(s).`}
            </p>
          </div>
          <div className="grid gap-1">
            <Label className="text-xs text-muted-foreground">
              Command template — use <code className="rounded bg-muted px-1">{"{i}"}</code> for the
              current number
            </Label>
            <Input
              className="w-full font-mono"
              value={step.template}
              placeholder="/waypoint remove {i}"
              onChange={(e) => update({ template: e.target.value })}
            />
          </div>
          {preview.length > 0 && (
            <p className="text-xs text-muted-foreground">
              e.g. <code className="rounded bg-muted px-1">{preview[0]}</code>
              {preview.length > 1 && (
                <>
                  {" … "}
                  <code className="rounded bg-muted px-1">{preview[preview.length - 1]}</code>
                </>
              )}
            </p>
          )}
        </div>
      );
    }
  }
}

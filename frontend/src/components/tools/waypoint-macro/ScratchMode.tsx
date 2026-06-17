// Generate-from-scratch mode: build a list of commands from templates such as
// bulk-remove-by-range, add-waypoint, and modify-waypoint.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, X } from "lucide-react";
import {
  addatiCommand,
  buildBulkRemoveCommands,
  COMMON_WAYPOINT_ICONS,
  modifyCommand,
  removeCommand,
} from "@/lib/waypoint-macro";
import { CommandCatalog } from "./CommandCatalog";

type StepKind = "bulkRemove" | "removeOne" | "add" | "modify";

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
interface AddStep {
  id: string;
  kind: "add";
  icon: string;
  x: number;
  y: number;
  z: number;
  pinned: boolean;
  color: string;
  title: string;
}
interface ModifyStep {
  id: string;
  kind: "modify";
  targetId: number;
  color: string;
  title: string;
}

type Step = BulkRemoveStep | RemoveOneStep | AddStep | ModifyStep;

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
    case "add":
      return {
        id,
        kind,
        icon: "circle",
        x: 0,
        y: 110,
        z: 0,
        pinned: false,
        color: "#FFFFFF",
        title: "Waypoint",
      };
    case "modify":
      return { id, kind, targetId: 0, color: "#FFFFFF", title: "Waypoint" };
  }
}

function stepCommands(step: Step): string[] {
  switch (step.kind) {
    case "bulkRemove":
      return buildBulkRemoveCommands(step.start, step.end);
    case "removeOne":
      return [removeCommand(step.targetId)];
    case "add":
      return [
        addatiCommand({
          name: step.title,
          x: step.x,
          y: step.y,
          z: step.z,
          color: step.color,
          icon: step.icon,
          pinned: step.pinned,
        }),
      ];
    case "modify":
      return [modifyCommand(step.targetId, step.color, step.title)];
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
            <Button type="button" variant="outline" size="sm" onClick={() => add("add")}>
              <Plus className="size-3.5" /> Add waypoint
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => add("modify")}>
              <Plus className="size-3.5" /> Modify waypoint
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
    case "add":
      return "Add waypoint";
    case "modify":
      return "Modify waypoint";
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
    case "add":
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">Icon</Label>
              <Select value={step.icon} onValueChange={(v) => v && update({ icon: v })}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMMON_WAYPOINT_ICONS.map((ic) => (
                    <SelectItem key={ic} value={ic}>
                      {ic}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Num label="X" value={step.x} onChange={(n) => update({ x: n })} />
            <Num label="Y" value={step.y} onChange={(n) => update({ y: n })} />
            <Num label="Z" value={step.z} onChange={(n) => update({ z: n })} />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">Color</Label>
              <Input
                className="w-28"
                value={step.color}
                placeholder="#FFFFFF"
                onChange={(e) => update({ color: e.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">Title</Label>
              <Input
                className="w-56"
                value={step.title}
                onChange={(e) => update({ title: e.target.value })}
              />
            </div>
            <label className="flex items-center gap-1 self-center text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={step.pinned}
                onChange={(e) => update({ pinned: e.target.checked })}
              />
              Pinned
            </label>
          </div>
        </div>
      );
    case "modify":
      return (
        <div className="flex flex-wrap items-end gap-3">
          <Num
            label="Waypoint id"
            value={step.targetId}
            onChange={(n) => update({ targetId: n })}
          />
          <div className="grid gap-1">
            <Label className="text-xs text-muted-foreground">Color</Label>
            <Input
              className="w-28"
              value={step.color}
              placeholder="#FFFFFF"
              onChange={(e) => update({ color: e.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs text-muted-foreground">Title</Label>
            <Input
              className="w-56"
              value={step.title}
              onChange={(e) => update({ title: e.target.value })}
            />
          </div>
        </div>
      );
  }
}

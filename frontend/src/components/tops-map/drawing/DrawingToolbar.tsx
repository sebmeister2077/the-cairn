// Floating tool palette for the planning-board drawing surface. Reads/writes
// the `drawing` slice; shown only while a board is open in draw mode.

import { useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PromptDialog } from "./PromptDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Pen,
  Highlighter,
  Eraser,
  Minus,
  ArrowUpRight,
  Square,
  Circle,
  Type,
  Smile,
  BoxSelect,
  Undo2,
  Redo2,
  Trash2,
  Save,
  Settings2,
} from "lucide-react";
import { PEN_PALETTE, STAMP_GLYPHS, drawingActions } from "@/store/slices/drawing";
import type { DrawTool } from "@/lib/drawing/types";
import { useDrawingBoards } from "@/hooks/useDrawingBoards";
import { cn } from "@/lib/utils";

const TOOLS: {
  tool: DrawTool;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { tool: "pen", label: "Pen", icon: Pen },
  { tool: "marker", label: "Marker", icon: Highlighter },
  { tool: "line", label: "Line", icon: Minus },
  { tool: "arrow", label: "Arrow", icon: ArrowUpRight },
  { tool: "rect", label: "Rectangle", icon: Square },
  { tool: "circle", label: "Circle", icon: Circle },
  { tool: "text", label: "Text", icon: Type },
  { tool: "stamp", label: "Stamp", icon: Smile },
  { tool: "eraser", label: "Eraser", icon: Eraser },
  { tool: "select", label: "Select", icon: BoxSelect },
];

const SHAPE_TOOLS = new Set<DrawTool>(["rect", "circle"]);

export function DrawingToolbar() {
  const dispatch = useAppDispatch();
  const activeTool = useAppSelector((s) => s.drawing.activeTool);
  const canUndo = useAppSelector((s) => s.drawing.past.length > 0);
  const canRedo = useAppSelector((s) => s.drawing.future.length > 0);
  const selectedIds = useAppSelector((s) => s.drawing.selectedIds);
  const activeBoard = useAppSelector((s) => s.drawing.activeBoard);
  const { saveBlueprint } = useDrawingBoards();

  const [blueprintOpen, setBlueprintOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);

  const showFill = SHAPE_TOOLS.has(activeTool);
  const showMarkerOpacity = activeTool === "marker";
  const isText = activeTool === "text";
  const isStamp = activeTool === "stamp";

  const onSaveBlueprint = async (name: string) => {
    if (!activeBoard || selectedIds.length === 0) return;
    const ids = new Set(selectedIds);
    const els = activeBoard.elements.filter((e) => ids.has(e.id));
    await saveBlueprint(name, els);
    dispatch(drawingActions.clearSelection());
    setBlueprintOpen(false);
  };

  return (
    <div className="pointer-events-auto flex flex-col gap-2 rounded-lg border bg-background/95 p-2 shadow-lg backdrop-blur">
      <div className="flex flex-wrap items-center gap-1">
        {TOOLS.map(({ tool, label, icon: Icon }) => (
          <Button
            key={tool}
            type="button"
            size="icon"
            variant={activeTool === tool ? "default" : "ghost"}
            title={label}
            aria-pressed={activeTool === tool}
            onClick={() => dispatch(drawingActions.setActiveTool(tool))}
          >
            <Icon className="size-4" />
          </Button>
        ))}

        <div className="mx-1 h-6 w-px bg-border" />

        <Popover>
          <PopoverTrigger
            render={<Button type="button" size="icon" variant="ghost" title="Style options" />}
          >
            <Settings2 className="size-4" />
          </PopoverTrigger>
          <PopoverContent side="bottom" align="start" className="w-72 space-y-3">
            <StyleControls
              showFill={showFill}
              showMarkerOpacity={showMarkerOpacity}
              isText={isText}
              isStamp={isStamp}
            />
          </PopoverContent>
        </Popover>

        <div className="mx-1 h-6 w-px bg-border" />

        <Button
          type="button"
          size="icon"
          variant="ghost"
          title="Undo (Ctrl+Z)"
          disabled={!canUndo}
          onClick={() => dispatch(drawingActions.undo())}
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          title="Redo (Ctrl+Y)"
          disabled={!canRedo}
          onClick={() => dispatch(drawingActions.redo())}
        >
          <Redo2 className="size-4" />
        </Button>
        {selectedIds.length > 0 && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            title="Save selection as blueprint"
            onClick={() => setBlueprintOpen(true)}
          >
            <Save className="size-4" />
          </Button>
        )}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          title="Clear board"
          onClick={() => setClearOpen(true)}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      {/* Quick colour + size row, always visible for fast tweaks. */}
      <div className="flex items-center gap-2">
        <ColorSwatches />
      </div>

      <PromptDialog
        open={blueprintOpen}
        title="Save as blueprint"
        label="Blueprint name"
        initialValue="Blueprint"
        submitLabel="Save"
        onSubmit={onSaveBlueprint}
        onCancel={() => setBlueprintOpen(false)}
      />

      <ConfirmDialog
        open={clearOpen}
        title="Clear board?"
        description="All drawings on this board will be removed. You can undo this afterwards."
        confirmLabel="Clear"
        variant="destructive"
        onConfirm={() => {
          dispatch(drawingActions.clearBoard());
          setClearOpen(false);
        }}
        onCancel={() => setClearOpen(false)}
      />
    </div>
  );
}

function ColorSwatches() {
  const dispatch = useAppDispatch();
  const color = useAppSelector((s) => s.drawing.style.color);
  return (
    <div className="flex flex-wrap gap-1">
      {PEN_PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          title={c}
          onClick={() => dispatch(drawingActions.updateStyle({ color: c }))}
          className={cn(
            "size-5 rounded-sm border",
            color === c ? "ring-2 ring-ring ring-offset-1" : "border-border",
          )}
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  );
}

function StyleControls({
  showFill,
  showMarkerOpacity,
  isText,
  isStamp,
}: {
  showFill: boolean;
  showMarkerOpacity: boolean;
  isText: boolean;
  isStamp: boolean;
}) {
  const dispatch = useAppDispatch();
  const style = useAppSelector((s) => s.drawing.style);

  return (
    <>
      {!isStamp && (
        <div className="space-y-1">
          <Label className="text-xs">
            {isText ? "Text size" : "Width"}: {isText ? style.textSizeBlocks : style.widthBlocks}{" "}
            blocks
          </Label>
          {isText ? (
            <Slider
              value={style.textSizeBlocks}
              min={16}
              max={400}
              step={4}
              onValueChange={(v) => dispatch(drawingActions.updateStyle({ textSizeBlocks: v }))}
            />
          ) : (
            <Slider
              value={style.widthBlocks}
              min={2}
              max={200}
              step={2}
              onValueChange={(v) => dispatch(drawingActions.updateStyle({ widthBlocks: v }))}
            />
          )}
        </div>
      )}

      {showMarkerOpacity && (
        <div className="space-y-1">
          <Label className="text-xs">
            Marker opacity: {Math.round(style.markerOpacity * 100)}%
          </Label>
          <Slider
            value={style.markerOpacity}
            min={0.1}
            max={0.9}
            step={0.05}
            onValueChange={(v) => dispatch(drawingActions.updateStyle({ markerOpacity: v }))}
          />
        </div>
      )}

      {showFill && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Fill shape</Label>
            <Switch
              checked={style.fillEnabled}
              onCheckedChange={(v) => dispatch(drawingActions.updateStyle({ fillEnabled: v }))}
            />
          </div>
          {style.fillEnabled && (
            <>
              <div className="flex flex-wrap gap-1">
                {PEN_PALETTE.slice(5).map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={c}
                    onClick={() => dispatch(drawingActions.updateStyle({ fillColor: c }))}
                    className={cn(
                      "size-5 rounded-sm border",
                      style.fillColor === c ? "ring-2 ring-ring ring-offset-1" : "border-border",
                    )}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
              <div className="space-y-1">
                <Label className="text-xs">
                  Fill opacity: {Math.round(style.fillOpacity * 100)}%
                </Label>
                <Slider
                  value={style.fillOpacity}
                  min={0.05}
                  max={1}
                  step={0.05}
                  onValueChange={(v) => dispatch(drawingActions.updateStyle({ fillOpacity: v }))}
                />
              </div>
            </>
          )}
        </div>
      )}

      {isStamp && (
        <div className="space-y-2">
          <Label className="text-xs">Stamp</Label>
          <div className="flex flex-wrap gap-1">
            {STAMP_GLYPHS.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => dispatch(drawingActions.updateStyle({ stampGlyph: g }))}
                className={cn(
                  "flex size-7 items-center justify-center rounded-sm border text-lg",
                  style.stampGlyph === g ? "ring-2 ring-ring" : "border-border",
                )}
              >
                {g}
              </button>
            ))}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Stamp size: {style.stampSizeBlocks} blocks</Label>
            <Slider
              value={style.stampSizeBlocks}
              min={20}
              max={500}
              step={10}
              onValueChange={(v) => dispatch(drawingActions.updateStyle({ stampSizeBlocks: v }))}
            />
          </div>
        </div>
      )}
    </>
  );
}

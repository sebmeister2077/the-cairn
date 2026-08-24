// Floating tool palette for the planning-board drawing surface. Reads/writes
// the `drawing` slice; shown only while a board is open in draw mode.
//
// Each tool carries its own style popup: selecting a tool (or right-clicking it)
// opens the settings relevant to that tool. A shared quick-colour row stays
// visible for fast recolouring.

import { useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  Bold,
  Italic,
  Undo2,
  Redo2,
  Trash2,
  Save,
  Wand2,
} from "lucide-react";
import { PEN_PALETTE, TEXT_FONTS, drawingActions } from "@/store/slices/drawing";
import type { DrawTool } from "@/lib/drawing/types";
import { STAMP_ICONS, type IconPrim } from "@/lib/drawing/stampIcons";
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
  { tool: "select", label: "Select (drag to move)", icon: BoxSelect },
];

const SHAPE_TOOLS = new Set<DrawTool>(["rect", "circle"]);
const WIDTH_TOOLS = new Set<DrawTool>(["pen", "marker", "line", "arrow", "rect", "circle"]);
/** Tools whose stroke colour is driven by the shared quick-colour row. */
const COLOR_TOOLS = new Set<DrawTool>([
  "pen",
  "marker",
  "line",
  "arrow",
  "rect",
  "circle",
  "text",
  "stamp",
]);
/** Tools that expose a style popup (everything except eraser / select). */
const STYLE_TOOLS = new Set<DrawTool>([
  "pen",
  "marker",
  "line",
  "arrow",
  "rect",
  "circle",
  "text",
  "stamp",
]);

export function DrawingToolbar() {
  const dispatch = useAppDispatch();
  const activeTool = useAppSelector((s) => s.drawing.activeTool);
  const canUndo = useAppSelector((s) => s.drawing.past.length > 0);
  const canRedo = useAppSelector((s) => s.drawing.future.length > 0);
  const selectedIds = useAppSelector((s) => s.drawing.selectedIds);
  const activeBoard = useAppSelector((s) => s.drawing.activeBoard);
  const style = useAppSelector((s) => s.drawing.style);
  const { saveBlueprint } = useDrawingBoards();

  const [openTool, setOpenTool] = useState<DrawTool | null>(null);
  const [blueprintOpen, setBlueprintOpen] = useState(false);

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
        {TOOLS.map(({ tool, label, icon: Icon }) => {
          const button = (
            <Button
              type="button"
              size="icon"
              variant={activeTool === tool ? "default" : "ghost"}
              title={`${label}${STYLE_TOOLS.has(tool) ? " — right-click for options" : ""}`}
              aria-pressed={activeTool === tool}
              onClick={() => dispatch(drawingActions.setActiveTool(tool))}
              onContextMenu={(e) => {
                if (!STYLE_TOOLS.has(tool)) return;
                e.preventDefault();
                dispatch(drawingActions.setActiveTool(tool));
                setOpenTool(tool);
              }}
            >
              <Icon className="size-4" />
            </Button>
          );

          if (!STYLE_TOOLS.has(tool)) {
            return <span key={tool}>{button}</span>;
          }

          return (
            <Popover
              key={tool}
              open={openTool === tool}
              onOpenChange={(o) => setOpenTool(o ? tool : null)}
            >
              <PopoverTrigger render={button} />
              <PopoverContent side="bottom" align="start" className="w-72 space-y-3">
                <ToolStylePanel tool={tool} />
              </PopoverContent>
            </Popover>
          );
        })}

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
        {selectedIds.length > 0 && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            title="Apply current style to selection"
            onClick={() => dispatch(drawingActions.restyleSelected(style))}
          >
            <Wand2 className="size-4" />
          </Button>
        )}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          title={
            selectedIds.length > 0
              ? `Delete selection (${selectedIds.length})`
              : "Select items to delete"
          }
          disabled={selectedIds.length === 0}
          onClick={() => dispatch(drawingActions.eraseElements(selectedIds))}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      {/* Quick colour row — the single place colour is set (shown for colour
          tools only). */}
      {COLOR_TOOLS.has(activeTool) && <ColorSwatches />}

      {activeTool === "select" && (
        <p className="px-1 text-[11px] text-muted-foreground">
          Drag a box to select, then drag inside it to move it. Use the wand to restyle, or
          double-click text to edit it.
        </p>
      )}

      <PromptDialog
        open={blueprintOpen}
        title="Save as blueprint"
        label="Blueprint name"
        initialValue="Blueprint"
        submitLabel="Save"
        onSubmit={onSaveBlueprint}
        onCancel={() => setBlueprintOpen(false)}
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

/** Small palette that writes an arbitrary style key (fill / outline colours). */
function SwatchRow({
  value,
  onPick,
  colors = PEN_PALETTE,
}: {
  value: string;
  onPick: (c: string) => void;
  colors?: readonly string[];
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          title={c}
          onClick={() => onPick(c)}
          className={cn(
            "size-5 rounded-sm border",
            value === c ? "ring-2 ring-ring ring-offset-1" : "border-border",
          )}
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  );
}

function ToolStylePanel({ tool }: { tool: DrawTool }) {
  const dispatch = useAppDispatch();
  const style = useAppSelector((s) => s.drawing.style);

  const isText = tool === "text";
  const isStamp = tool === "stamp";
  const isMarker = tool === "marker";
  const showFill = SHAPE_TOOLS.has(tool);
  const showWidth = WIDTH_TOOLS.has(tool);

  return (
    <>
      {showWidth && (
        <div className="space-y-1">
          <Label className="text-xs">Width: {style.widthBlocks} blocks</Label>
          <Slider
            value={style.widthBlocks}
            min={2}
            max={200}
            step={2}
            showInput
            onValueChange={(v) => dispatch(drawingActions.updateStyle({ widthBlocks: v }))}
          />
        </div>
      )}

      {isText && (
        <div className="space-y-1">
          <Label className="text-xs">Text size: {style.textSizeBlocks} blocks</Label>
          <Slider
            value={style.textSizeBlocks}
            min={16}
            max={400}
            step={4}
            showInput
            onValueChange={(v) => dispatch(drawingActions.updateStyle({ textSizeBlocks: v }))}
          />
        </div>
      )}

      {/* Opacity: marker keeps its own highlighter alpha; everything else uses
          the general "what you draw next" opacity. */}
      {isMarker ? (
        <div className="space-y-1">
          <Label className="text-xs">
            Marker opacity: {Math.round(style.markerOpacity * 100)}%
          </Label>
          <Slider
            value={style.markerOpacity}
            min={0.1}
            max={0.9}
            step={0.05}
            showInput
            onValueChange={(v) => dispatch(drawingActions.updateStyle({ markerOpacity: v }))}
          />
        </div>
      ) : (
        <div className="space-y-1">
          <Label className="text-xs">Opacity: {Math.round(style.opacity * 100)}%</Label>
          <Slider
            value={style.opacity}
            min={0.1}
            max={1}
            step={0.05}
            showInput
            onValueChange={(v) => dispatch(drawingActions.updateStyle({ opacity: v }))}
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
              <SwatchRow
                value={style.fillColor}
                colors={PEN_PALETTE.slice(5)}
                onPick={(c) => dispatch(drawingActions.updateStyle({ fillColor: c }))}
              />
              <div className="space-y-1">
                <Label className="text-xs">
                  Fill opacity: {Math.round(style.fillOpacity * 100)}%
                </Label>
                <Slider
                  value={style.fillOpacity}
                  min={0.05}
                  max={1}
                  step={0.05}
                  showInput
                  onValueChange={(v) => dispatch(drawingActions.updateStyle({ fillOpacity: v }))}
                />
              </div>
            </>
          )}
        </div>
      )}

      {isText && <TextFormatControls />}

      {isStamp && <StampControls />}

      {(isText || isStamp) && <OutlineControls />}
    </>
  );
}

function TextFormatControls() {
  const dispatch = useAppDispatch();
  const style = useAppSelector((s) => s.drawing.style);
  return (
    <div className="space-y-2">
      <Label className="text-xs">Formatting</Label>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="icon"
          variant={style.textBold ? "default" : "outline"}
          title="Bold"
          aria-pressed={style.textBold}
          onClick={() => dispatch(drawingActions.updateStyle({ textBold: !style.textBold }))}
        >
          <Bold className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant={style.textItalic ? "default" : "outline"}
          title="Italic"
          aria-pressed={style.textItalic}
          onClick={() => dispatch(drawingActions.updateStyle({ textItalic: !style.textItalic }))}
        >
          <Italic className="size-4" />
        </Button>
      </div>
      <div className="flex flex-wrap gap-1">
        {TEXT_FONTS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => dispatch(drawingActions.updateStyle({ textFont: f.value }))}
            className={cn(
              "rounded-sm border px-2 py-1 text-xs",
              style.textFont === f.value ? "ring-2 ring-ring" : "border-border",
            )}
            style={{ fontFamily: f.value }}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function StampControls() {
  const dispatch = useAppDispatch();
  const style = useAppSelector((s) => s.drawing.style);
  return (
    <div className="space-y-2">
      <Label className="text-xs">Icon</Label>
      <div className="grid max-h-40 grid-cols-8 gap-1 overflow-y-auto pr-1">
        {STAMP_ICONS.map((ic) => (
          <button
            key={ic.id}
            type="button"
            title={ic.label}
            onClick={() => dispatch(drawingActions.updateStyle({ stampIconId: ic.id }))}
            className={cn(
              "flex size-7 items-center justify-center rounded-sm border",
              style.stampIconId === ic.id ? "ring-2 ring-ring" : "border-border",
            )}
          >
            <StampIconSvg node={ic.node} className="size-5" />
          </button>
        ))}
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Stamp size: {style.stampSizeBlocks} blocks</Label>
        <Slider
          value={style.stampSizeBlocks}
          min={10}
          max={500}
          step={5}
          showInput
          onValueChange={(v) => dispatch(drawingActions.updateStyle({ stampSizeBlocks: v }))}
        />
      </div>
    </div>
  );
}

/** Inline SVG rendering of a stamp icon's primitives (picker UI). */
function StampIconSvg({ node, className }: { node: IconPrim[]; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {node.map((p, i) => {
        switch (p.t) {
          case "path":
            return <path key={i} d={p.d} />;
          case "circle":
            return (
              <circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill={p.fill ? "currentColor" : "none"} />
            );
          case "line":
            return <line key={i} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} />;
          case "polyline":
            return <polyline key={i} points={p.points} />;
          case "polygon":
            return <polygon key={i} points={p.points} />;
        }
      })}
    </svg>
  );
}

function OutlineControls() {
  const dispatch = useAppDispatch();
  const style = useAppSelector((s) => s.drawing.style);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">Outline</Label>
        <Switch
          checked={style.outlineEnabled}
          onCheckedChange={(v) => dispatch(drawingActions.updateStyle({ outlineEnabled: v }))}
        />
      </div>
      {style.outlineEnabled && (
        <SwatchRow
          value={style.outlineColor}
          onPick={(c) => dispatch(drawingActions.updateStyle({ outlineColor: c }))}
        />
      )}
    </div>
  );
}

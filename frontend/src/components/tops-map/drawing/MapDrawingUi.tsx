// Floating planning-board controls for the TOPS map: a draw-mode toggle, board
// + blueprint pickers, and the tool palette. Sits above the map canvas.

import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { drawingActions } from "@/store/slices/drawing";
import { newId } from "@/lib/drawing/types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Pencil, Layers, Stamp as StampIcon } from "lucide-react";
import { DrawingToolbar } from "./DrawingToolbar";
import { BoardsPanel } from "./BoardsPanel";
import { BlueprintLibrary } from "./BlueprintLibrary";
import { PromptDialog } from "./PromptDialog";

export function MapDrawingUi({ worldKey }: { worldKey: string | null }) {
  const dispatch = useAppDispatch();
  const drawingMode = useAppSelector((s) => s.drawing.drawingMode);
  const activeBoardId = useAppSelector((s) => s.drawing.activeBoardId);
  const activeBoardName = useAppSelector((s) => s.drawing.activeBoard?.name);
  const pasteId = useAppSelector((s) => s.drawing.pasteBlueprintId);
  const canUndo = useAppSelector((s) => s.drawing.past.length > 0);
  const canRedo = useAppSelector((s) => s.drawing.future.length > 0);
  const pendingTextPos = useAppSelector((s) => s.drawing.pendingTextPos);
  const textStyle = useAppSelector((s) => s.drawing.style);
  // Mirror the fullscreen "Hide controls" declutter toggle.
  const controlsCollapsed = useAppSelector((s) => s.mapView.fullscreenControlsCollapsed);

  // Keyboard: undo/redo while drawing; Esc cancels paste mode.
  useEffect(() => {
    if (!drawingMode) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === "Escape" && pasteId) {
        dispatch(drawingActions.cancelPaste());
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        if (canUndo) {
          e.preventDefault();
          dispatch(drawingActions.undo());
        }
      } else if (
        (e.ctrlKey || e.metaKey) &&
        (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))
      ) {
        if (canRedo) {
          e.preventDefault();
          dispatch(drawingActions.redo());
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawingMode, pasteId, canUndo, canRedo, dispatch]);

  const textDialog = (
    <PromptDialog
      open={pendingTextPos !== null}
      title="Add text label"
      label="Label text"
      placeholder="e.g. North gate"
      submitLabel="Place"
      onSubmit={(text) => {
        if (pendingTextPos) {
          dispatch(
            drawingActions.addElement({
              id: newId(),
              kind: "text",
              pos: pendingTextPos,
              text,
              sizeBlocks: textStyle.textSizeBlocks,
              color: textStyle.color,
              opacity: 1,
              createdAt: Date.now(),
            }),
          );
        }
        dispatch(drawingActions.cancelText());
      }}
      onCancel={() => dispatch(drawingActions.cancelText())}
    />
  );

  // "Hide controls" collapses the bottom bar + toolbar, but keep the text
  // dialog mounted so any pending label still resolves.
  if (controlsCollapsed) return textDialog;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex flex-col items-center gap-2 px-3">
      {drawingMode && activeBoardId && <DrawingToolbar />}

      {drawingMode && !activeBoardId && (
        <div className="pointer-events-auto rounded-md border bg-background/95 px-3 py-2 text-xs text-muted-foreground shadow">
          Create or open a board to start drawing.
        </div>
      )}

      {drawingMode && pasteId && (
        <div className="pointer-events-auto rounded-md border bg-primary/10 px-3 py-1.5 text-xs shadow">
          Click the map to stamp the blueprint · Esc to stop
        </div>
      )}

      <div className="pointer-events-auto flex items-center gap-1 rounded-lg border bg-background/95 p-1 shadow-lg backdrop-blur">
        <Button
          type="button"
          size="sm"
          variant={drawingMode ? "default" : "outline"}
          onClick={() => dispatch(drawingActions.setDrawingMode(!drawingMode))}
          title="Toggle planning-board drawing"
        >
          <Pencil className="mr-1 size-4" />
          {drawingMode ? "Drawing" : "Plan"}
        </Button>

        <Popover>
          <PopoverTrigger render={<Button type="button" size="sm" variant="ghost" />}>
            <Layers className="mr-1 size-4" />
            {activeBoardName ?? "Boards"}
          </PopoverTrigger>
          <PopoverContent side="top" align="center" className="w-72">
            <BoardsPanel worldKey={worldKey} />
          </PopoverContent>
        </Popover>

        <Popover>
          <PopoverTrigger render={<Button type="button" size="sm" variant="ghost" />}>
            <StampIcon className="mr-1 size-4" />
            Blueprints
          </PopoverTrigger>
          <PopoverContent side="top" align="center" className="w-72">
            <BlueprintLibrary />
          </PopoverContent>
        </Popover>
      </div>
      {textDialog}
    </div>
  );
}

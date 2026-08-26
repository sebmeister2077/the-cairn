// Layer management for the active planning board. Layers are independent
// drawing surfaces: hidden layers aren't drawn, locked layers can't be edited,
// and the active layer receives new elements. Stack order (top → bottom here)
// controls what draws on top.

import { useMemo, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { drawingActions } from "@/store/slices/drawing";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PromptDialog } from "./PromptDialog";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  Plus,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function LayersPanel() {
  const dispatch = useAppDispatch();
  const board = useAppSelector((s) => s.drawing.activeBoard);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  // Count elements per layer (default layer collects elements without a layerId).
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    if (!board) return map;
    const defaultId = board.layers[0]?.id;
    for (const el of board.elements) {
      const id = el.layerId ?? defaultId;
      if (id) map.set(id, (map.get(id) ?? 0) + 1);
    }
    return map;
  }, [board]);

  if (!board) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">Open a board to use layers.</p>;
  }

  // Show top layer first (array is stored bottom → top).
  const ordered = [...board.layers].reverse();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Layers</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => dispatch(drawingActions.layerAdded(undefined))}
        >
          <Plus className="mr-1 size-3.5" /> New
        </Button>
      </div>

      <div className="max-h-64 space-y-1 overflow-y-auto">
        {ordered.map((layer, displayIdx) => {
          const isActive = layer.id === board.activeLayerId;
          const isTop = displayIdx === 0;
          const isBottom = displayIdx === ordered.length - 1;
          return (
            <div
              key={layer.id}
              className={cn(
                "flex items-center gap-1 rounded-md border px-1.5 py-1",
                isActive ? "border-primary bg-primary/5" : "border-border",
              )}
            >
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-6"
                title={layer.visible ? "Hide layer" : "Show layer"}
                onClick={() =>
                  dispatch(
                    drawingActions.setLayerVisible({ id: layer.id, visible: !layer.visible }),
                  )
                }
              >
                {layer.visible ? (
                  <Eye className="size-3.5" />
                ) : (
                  <EyeOff className="size-3.5 text-muted-foreground" />
                )}
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-6"
                title={layer.locked ? "Unlock layer" : "Lock layer"}
                onClick={() =>
                  dispatch(drawingActions.setLayerLocked({ id: layer.id, locked: !layer.locked }))
                }
              >
                {layer.locked ? (
                  <Lock className="size-3.5 text-muted-foreground" />
                ) : (
                  <LockOpen className="size-3.5" />
                )}
              </Button>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1 text-left cursor-pointer"
                title="Set as active layer (double-click to rename)"
                onClick={() => dispatch(drawingActions.setActiveLayer(layer.id))}
                onDoubleClick={() => setRenameTarget({ id: layer.id, name: layer.name })}
              >
                {isActive && <Check className="size-3.5 shrink-0 text-primary" />}
                <span className={cn("truncate text-sm", !layer.visible && "text-muted-foreground")}>
                  {layer.name}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {counts.get(layer.id) ?? 0}
                </span>
              </button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-6"
                title="Move up"
                disabled={isTop}
                onClick={() => dispatch(drawingActions.moveLayer({ id: layer.id, dir: 1 }))}
              >
                <ChevronUp className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-6"
                title="Move down"
                disabled={isBottom}
                onClick={() => dispatch(drawingActions.moveLayer({ id: layer.id, dir: -1 }))}
              >
                <ChevronDown className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-6 text-destructive"
                title={board.layers.length <= 1 ? "Can't delete the only layer" : "Delete layer"}
                disabled={board.layers.length <= 1}
                onClick={() => setDeleteTarget({ id: layer.id, name: layer.name })}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          );
        })}
      </div>

      <PromptDialog
        open={renameTarget !== null}
        title="Rename layer"
        label="Layer name"
        initialValue={renameTarget?.name ?? ""}
        submitLabel="Rename"
        onSubmit={(name) => {
          if (renameTarget) dispatch(drawingActions.layerRenamed({ id: renameTarget.id, name }));
          setRenameTarget(null);
        }}
        onCancel={() => setRenameTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete layer?"
        description={
          deleteTarget
            ? `"${deleteTarget.name}" and every drawing on it will be permanently removed.`
            : undefined
        }
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => {
          if (deleteTarget) dispatch(drawingActions.layerRemoved(deleteTarget.id));
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

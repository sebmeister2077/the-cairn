// Blueprint library: reusable drawing groups. Pick one to enter paste mode
// (click the map to stamp copies), or delete it.

import { useMemo, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { drawingActions } from "@/store/slices/drawing";
import { useDrawingBoards } from "@/hooks/useDrawingBoards";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Search, Stamp, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export function BlueprintLibrary() {
  const dispatch = useAppDispatch();
  const blueprints = useAppSelector((s) => s.drawing.blueprintIndex);
  const pasteId = useAppSelector((s) => s.drawing.pasteBlueprintId);
  const activeBoardId = useAppSelector((s) => s.drawing.activeBoardId);
  const { removeBlueprint } = useDrawingBoards();
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return blueprints;
    return blueprints.filter((b) => b.name.toLowerCase().includes(q));
  }, [blueprints, query]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Blueprints</span>
        {pasteId && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => dispatch(drawingActions.cancelPaste())}
          >
            <X className="mr-1 size-3.5" /> Stop pasting
          </Button>
        )}
      </div>

      {!activeBoardId && (
        <p className="px-1 text-xs text-muted-foreground">Open a board to paste blueprints.</p>
      )}

      {blueprints.length > 3 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search blueprints…"
            className="h-8 pl-7 text-sm"
          />
        </div>
      )}

      <div className="max-h-64 space-y-1 overflow-y-auto">
        {filtered.length === 0 && blueprints.length > 0 && (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">
            No blueprints match “{query}”.
          </p>
        )}
        {blueprints.length === 0 && (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">
            No blueprints yet. Select drawings with the Select tool, then Save as blueprint.
          </p>
        )}
        {filtered.map((b) => (
          <div
            key={b.id}
            className={cn(
              "flex items-center gap-1 rounded-md border px-2 py-1.5",
              b.id === pasteId ? "border-primary bg-primary/5" : "border-border",
            )}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{b.name}</p>
              <p className="text-[10px] text-muted-foreground">
                {b.elementCount} items · {Math.round(b.widthBlocks)}×{Math.round(b.heightBlocks)}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant={b.id === pasteId ? "default" : "outline"}
              disabled={!activeBoardId}
              title="Paste onto the map"
              onClick={() => dispatch(drawingActions.startPaste(b.id))}
            >
              <Stamp className="mr-1 size-3.5" /> Paste
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-6 text-destructive"
              title="Delete blueprint"
              onClick={() => setDeleteTarget({ id: b.id, name: b.name })}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete blueprint?"
        description={
          deleteTarget ? `"${deleteTarget.name}" will be removed from your library.` : undefined
        }
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={async () => {
          if (deleteTarget) await removeBlueprint(deleteTarget.id);
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

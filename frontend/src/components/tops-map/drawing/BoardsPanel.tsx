// Board management: create / select / rename / delete planning boards, with an
// optional "this world only" filter.

import { useMemo, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { drawingActions } from "@/store/slices/drawing";
import { useDrawingBoards } from "@/hooks/useDrawingBoards";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { HelpTip } from "@/components/ui/help-tip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PromptDialog } from "./PromptDialog";
import { Plus, Pencil, Trash2, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

type PromptState = { kind: "create" } | { kind: "rename"; id: string; current: string } | null;

export function BoardsPanel({ worldKey }: { worldKey: string | null }) {
  const dispatch = useAppDispatch();
  const boardIndex = useAppSelector((s) => s.drawing.boardIndex);
  const activeBoardId = useAppSelector((s) => s.drawing.activeBoardId);
  const worldFilter = useAppSelector((s) => s.drawing.worldFilterEnabled);
  const { createBoard, selectBoard, renameBoard, removeBoard } = useDrawingBoards();

  const [prompt, setPrompt] = useState<PromptState>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const boards = useMemo(
    () => (worldFilter ? boardIndex.filter((b) => b.worldKey === worldKey) : boardIndex),
    [boardIndex, worldFilter, worldKey],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Boards</span>
        <div className="flex items-center gap-1">
          {activeBoardId && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              title="Close the active board"
              onClick={() => dispatch(drawingActions.boardClosed())}
            >
              <X className="mr-1 size-3.5" /> Close
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setPrompt({ kind: "create" })}
          >
            <Plus className="mr-1 size-3.5" /> New
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="inline-flex items-center text-xs text-muted-foreground">
          This world only
          <HelpTip text="Only show boards you drew on the current map (server/world). Turn off to see every board across all worlds." />
        </span>
        <Switch
          checked={worldFilter}
          onCheckedChange={(v) => dispatch(drawingActions.setWorldFilterEnabled(v))}
        />
      </div>

      <div className="max-h-64 space-y-1 overflow-y-auto">
        {boards.length === 0 && (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">
            No boards yet. Create one to start planning.
          </p>
        )}
        {boards.map((b) => (
          <div
            key={b.id}
            className={cn(
              "flex items-center gap-1 rounded-md border px-2 py-1.5",
              b.id === activeBoardId ? "border-primary bg-primary/5" : "border-border",
            )}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              title={b.id === activeBoardId ? "Click to close this board" : "Open this board"}
              onClick={() =>
                b.id === activeBoardId
                  ? dispatch(drawingActions.boardClosed())
                  : void selectBoard(b.id)
              }
            >
              {b.id === activeBoardId && <Check className="size-3.5 shrink-0 text-primary" />}
              <span className="truncate text-sm">{b.name}</span>
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                {b.elementCount}
              </span>
            </button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-6"
              title="Rename"
              onClick={() => setPrompt({ kind: "rename", id: b.id, current: b.name })}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-6 text-destructive"
              title="Delete"
              onClick={() => setDeleteTarget({ id: b.id, name: b.name })}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>

      <PromptDialog
        open={prompt !== null}
        title={prompt?.kind === "rename" ? "Rename board" : "New board"}
        label="Board name"
        initialValue={prompt?.kind === "rename" ? prompt.current : "New board"}
        submitLabel={prompt?.kind === "rename" ? "Rename" : "Create"}
        onSubmit={async (name) => {
          if (prompt?.kind === "rename") await renameBoard(prompt.id, name);
          else await createBoard(name, worldKey);
          setPrompt(null);
        }}
        onCancel={() => setPrompt(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete board?"
        description={
          deleteTarget
            ? `"${deleteTarget.name}" and all its drawings will be permanently removed.`
            : undefined
        }
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={async () => {
          if (deleteTarget) await removeBoard(deleteTarget.id);
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

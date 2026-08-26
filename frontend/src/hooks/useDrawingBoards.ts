// Board + blueprint CRUD that keeps Redux and IndexedDB in sync. Components use
// this instead of dispatching raw actions so every create/rename/delete also
// lands in IndexedDB (the autosave subscriber only covers the active board).

import { useCallback } from "react";
import { useAppDispatch } from "@/store/hooks";
import { drawingActions } from "@/store/slices/drawing";
import {
    deleteBlueprint,
    deleteBoard,
    getBlueprint,
    getBoard,
    putBlueprint,
    putBoard,
} from "@/lib/drawing/boardStore";
import {
    type Blueprint,
    type Board,
    type DrawElement,
    DRAWING_SCHEMA_VERSION,
    ensureBoardLayers,
    newId,
    newLayer,
} from "@/lib/drawing/types";
import { makeBlueprint } from "@/lib/drawing/elements";

export function useDrawingBoards() {
    const dispatch = useAppDispatch();

    const createBoard = useCallback(
        async (name: string, worldKey: string | null): Promise<Board> => {
            const now = Date.now();
            const layer = newLayer("Layer 1");
            const board: Board = {
                id: newId(),
                name: name.trim() || "Untitled board",
                worldKey,
                elements: [],
                layers: [layer],
                activeLayerId: layer.id,
                createdAt: now,
                updatedAt: now,
                schemaVersion: DRAWING_SCHEMA_VERSION,
            };
            dispatch(drawingActions.boardCreated(board));
            await putBoard(board);
            return board;
        },
        [dispatch],
    );

    const selectBoard = useCallback(
        async (id: string): Promise<void> => {
            const board = await getBoard(id);
            if (board) dispatch(drawingActions.boardSelected(ensureBoardLayers(board)));
        },
        [dispatch],
    );

    const renameBoard = useCallback(
        async (id: string, name: string): Promise<void> => {
            const trimmed = name.trim() || "Untitled board";
            dispatch(drawingActions.boardRenamed({ id, name: trimmed }));
            const board = await getBoard(id);
            if (board) await putBoard({ ...board, name: trimmed, updatedAt: Date.now() });
        },
        [dispatch],
    );

    const removeBoard = useCallback(
        async (id: string): Promise<void> => {
            dispatch(drawingActions.boardDeleted(id));
            await deleteBoard(id);
        },
        [dispatch],
    );

    const saveBlueprint = useCallback(
        async (name: string, elements: DrawElement[]): Promise<Blueprint | null> => {
            const bp = makeBlueprint(name.trim() || "Blueprint", elements, Date.now());
            if (!bp) return null;
            await putBlueprint(bp);
            dispatch(drawingActions.blueprintCreated(bp));
            return bp;
        },
        [dispatch],
    );

    const removeBlueprint = useCallback(
        async (id: string): Promise<void> => {
            dispatch(drawingActions.blueprintDeleted(id));
            await deleteBlueprint(id);
        },
        [dispatch],
    );

    const loadBlueprint = useCallback((id: string) => getBlueprint(id), []);

    return {
        createBoard,
        selectBoard,
        renameBoard,
        removeBoard,
        saveBlueprint,
        removeBlueprint,
        loadBlueprint,
    };
}

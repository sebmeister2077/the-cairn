// Bridges the `drawing` Redux slice to IndexedDB.
//
//   * `installDrawingPersistence` autosaves the active board (debounced)
//     whenever its element list / metadata changes.
//   * `hydrateDrawingIndexes` loads the board + blueprint indexes once at
//     startup so the boards panel has something to show without opening every
//     board's full element payload.

import type { Store } from "@reduxjs/toolkit";
import type { RootState } from "./index";
import { drawingActions } from "./slices/drawing";
import { listBoardIndex, listBlueprintIndex, putBoard } from "@/lib/drawing/boardStore";

const AUTOSAVE_DEBOUNCE_MS = 600;

export function installDrawingPersistence(store: Store<RootState>): void {
    let lastBoardRef = store.getState().drawing.activeBoard;
    let timer: ReturnType<typeof setTimeout> | null = null;

    store.subscribe(() => {
        const board = store.getState().drawing.activeBoard;
        if (board === lastBoardRef) return;
        lastBoardRef = board;
        if (!board) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            const current = store.getState().drawing.activeBoard;
            if (current) void putBoard(current);
        }, AUTOSAVE_DEBOUNCE_MS);
    });
}

export async function hydrateDrawingIndexes(store: Store<RootState>): Promise<void> {
    const [boards, blueprints] = await Promise.all([listBoardIndex(), listBlueprintIndex()]);
    store.dispatch(drawingActions.boardIndexLoaded(boards));
    store.dispatch(drawingActions.blueprintIndexLoaded(blueprints));
}

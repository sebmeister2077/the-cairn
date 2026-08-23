// UI + working state for the TOPS map planning boards ("draw on the map").
//
// This slice is BLACKLISTED from the localStorage envelope (see
// rootPersistence.ts): boards can be large, so the authoritative copy lives in
// IndexedDB (lib/drawing/boardStore.ts) and is mirrored here by the persistence
// subscriber. Only the small tool/UI prefs and the active working board sit in
// Redux. Undo/redo history is in-memory and never persisted.

import { createSlice, current, type PayloadAction } from "@reduxjs/toolkit";
import {
    type Blueprint,
    type BlueprintIndexEntry,
    type Board,
    type BoardIndexEntry,
    type DrawElement,
    type DrawTool,
    type WorldPoint,
    boardIndexEntry,
} from "@/lib/drawing/types";

const HISTORY_LIMIT = 60;

/** Snip-tool-style pen palette (30 colours) surfaced by the toolbar. */
export const PEN_PALETTE: readonly string[] = [
    "#000000", "#5c5c5c", "#8a8a8a", "#c8c8c8", "#ffffff",
    "#7f1d1d", "#dc2626", "#f87171", "#ea580c", "#f59e0b",
    "#fde047", "#a3e635", "#22c55e", "#15803d", "#0d9488",
    "#06b6d4", "#38bdf8", "#2563eb", "#1e3a8a", "#4f46e5",
    "#7c3aed", "#a855f7", "#d946ef", "#ec4899", "#f43f5e",
    "#7c2d12", "#a16207", "#3f6212", "#0f766e", "#334155",
];

/** Emoji stamps offered in the picker. */
export const STAMP_GLYPHS: readonly string[] = [
    "🏠", "🏰", "⛏️", "🌲", "🌾", "🚜", "⚓", "⭐", "❗", "❓",
    "🏭", "🛖", "🐄", "🐖", "🔥", "💧", "🗺️", "📦", "🚩", "⚔️",
];

export interface ToolStyle {
    /** Stroke colour for pen / shapes / text. */
    color: string;
    /** Pen / shape stroke width in world blocks. */
    widthBlocks: number;
    /** Marker (highlighter) opacity 0..1. */
    markerOpacity: number;
    /** Whether shapes are filled. */
    fillEnabled: boolean;
    fillColor: string;
    fillOpacity: number;
    strokeOpacity: number;
    textSizeBlocks: number;
    stampGlyph: string;
    stampSizeBlocks: number;
}

export interface DrawingState {
    /** Whether the draw surface intercepts pointer input (pan disabled). */
    drawingMode: boolean;
    activeTool: DrawTool;
    style: ToolStyle;

    boardIndex: BoardIndexEntry[];
    activeBoardId: string | null;
    /** Full working copy of the active board — element edits happen here. */
    activeBoard: Board | null;
    boardsHydrated: boolean;

    // Undo/redo — snapshots of the active board's element list.
    past: DrawElement[][];
    future: DrawElement[][];

    /** Marquee-selected element ids (blueprint source). */
    selectedIds: string[];

    blueprintIndex: BlueprintIndexEntry[];
    /** Blueprint currently being stamped (paste mode), or null. */
    pasteBlueprintId: string | null;
    /** World position awaiting a text label from the themed dialog, or null. */
    pendingTextPos: WorldPoint | null;
    /** "This world only" board list filter. */
    worldFilterEnabled: boolean;
}

const DEFAULT_STYLE: ToolStyle = {
    color: "#dc2626",
    widthBlocks: 24,
    markerOpacity: 0.4,
    fillEnabled: false,
    fillColor: "#f59e0b",
    fillOpacity: 0.3,
    strokeOpacity: 1,
    textSizeBlocks: 80,
    stampGlyph: STAMP_GLYPHS[0],
    stampSizeBlocks: 120,
};

/** Exported so the map viewer can seed a ref before the `drawing` prop lands. */
export const DEFAULT_TOOL_STYLE: ToolStyle = DEFAULT_STYLE;

export const initialDrawingState: DrawingState = {
    drawingMode: false,
    activeTool: "pen",
    style: DEFAULT_STYLE,
    boardIndex: [],
    activeBoardId: null,
    activeBoard: null,
    boardsHydrated: false,
    past: [],
    future: [],
    selectedIds: [],
    blueprintIndex: [],
    pasteBlueprintId: null,
    pendingTextPos: null,
    worldFilterEnabled: false,
};

/** Bump the active board's timestamp and keep its index entry in sync. */
function touch(state: DrawingState): void {
    if (!state.activeBoard) return;
    state.activeBoard.updatedAt = Date.now();
    const entry = boardIndexEntry(current(state.activeBoard));
    const i = state.boardIndex.findIndex((e) => e.id === entry.id);
    if (i >= 0) state.boardIndex[i] = entry;
    else state.boardIndex.unshift(entry);
    state.boardIndex.sort((a, b) => b.updatedAt - a.updatedAt);
}

function pushHistory(state: DrawingState): void {
    if (!state.activeBoard) return;
    state.past.push(current(state.activeBoard.elements) as DrawElement[]);
    if (state.past.length > HISTORY_LIMIT) state.past.shift();
    state.future = [];
}

export const drawingSlice = createSlice({
    name: "drawing",
    initialState: initialDrawingState,
    reducers: {
        setDrawingMode(state, action: PayloadAction<boolean>) {
            state.drawingMode = action.payload;
            if (!action.payload) {
                state.pasteBlueprintId = null;
                state.selectedIds = [];
            }
        },
        setActiveTool(state, action: PayloadAction<DrawTool>) {
            state.activeTool = action.payload;
            if (action.payload !== "select") state.selectedIds = [];
            state.pasteBlueprintId = null;
        },
        updateStyle(state, action: PayloadAction<Partial<ToolStyle>>) {
            state.style = { ...state.style, ...action.payload };
        },

        // ── Board lifecycle ────────────────────────────────────────────────
        boardIndexLoaded(state, action: PayloadAction<BoardIndexEntry[]>) {
            state.boardIndex = action.payload;
            state.boardsHydrated = true;
        },
        boardCreated(state, action: PayloadAction<Board>) {
            const board = action.payload;
            state.boardIndex.unshift(boardIndexEntry(board));
            state.activeBoard = board;
            state.activeBoardId = board.id;
            state.past = [];
            state.future = [];
            state.selectedIds = [];
        },
        boardSelected(state, action: PayloadAction<Board>) {
            state.activeBoard = action.payload;
            state.activeBoardId = action.payload.id;
            state.past = [];
            state.future = [];
            state.selectedIds = [];
        },
        boardClosed(state) {
            state.activeBoard = null;
            state.activeBoardId = null;
            state.past = [];
            state.future = [];
            state.selectedIds = [];
        },
        boardRenamed(state, action: PayloadAction<{ id: string; name: string }>) {
            const { id, name } = action.payload;
            const entry = state.boardIndex.find((e) => e.id === id);
            if (entry) entry.name = name;
            if (state.activeBoard?.id === id) {
                state.activeBoard.name = name;
                state.activeBoard.updatedAt = Date.now();
            }
        },
        boardDeleted(state, action: PayloadAction<string>) {
            const id = action.payload;
            state.boardIndex = state.boardIndex.filter((e) => e.id !== id);
            if (state.activeBoardId === id) {
                state.activeBoard = null;
                state.activeBoardId = null;
                state.past = [];
                state.future = [];
                state.selectedIds = [];
            }
        },

        // ── Element mutations (each snapshots history first) ────────────────
        addElement(state, action: PayloadAction<DrawElement>) {
            if (!state.activeBoard) return;
            pushHistory(state);
            state.activeBoard.elements.push(action.payload);
            touch(state);
        },
        addElements(state, action: PayloadAction<DrawElement[]>) {
            if (!state.activeBoard || action.payload.length === 0) return;
            pushHistory(state);
            state.activeBoard.elements.push(...action.payload);
            touch(state);
        },
        eraseElements(state, action: PayloadAction<string[]>) {
            if (!state.activeBoard || action.payload.length === 0) return;
            const ids = new Set(action.payload);
            pushHistory(state);
            state.activeBoard.elements = state.activeBoard.elements.filter((el) => !ids.has(el.id));
            state.selectedIds = state.selectedIds.filter((id) => !ids.has(id));
            touch(state);
        },
        clearBoard(state) {
            if (!state.activeBoard || state.activeBoard.elements.length === 0) return;
            pushHistory(state);
            state.activeBoard.elements = [];
            state.selectedIds = [];
            touch(state);
        },
        undo(state) {
            if (!state.activeBoard || state.past.length === 0) return;
            const prev = state.past.pop() as DrawElement[];
            state.future.push(current(state.activeBoard.elements) as DrawElement[]);
            state.activeBoard.elements = prev;
            touch(state);
        },
        redo(state) {
            if (!state.activeBoard || state.future.length === 0) return;
            const next = state.future.pop() as DrawElement[];
            state.past.push(current(state.activeBoard.elements) as DrawElement[]);
            state.activeBoard.elements = next;
            touch(state);
        },

        // ── Selection ───────────────────────────────────────────────────────
        setSelection(state, action: PayloadAction<string[]>) {
            state.selectedIds = action.payload;
        },
        clearSelection(state) {
            state.selectedIds = [];
        },

        // ── Blueprints ──────────────────────────────────────────────────────
        blueprintIndexLoaded(state, action: PayloadAction<BlueprintIndexEntry[]>) {
            state.blueprintIndex = action.payload;
        },
        blueprintCreated(state, action: PayloadAction<Blueprint>) {
            const { id, name, widthBlocks, heightBlocks, createdAt, elements } = action.payload;
            state.blueprintIndex.unshift({
                id,
                name,
                widthBlocks,
                heightBlocks,
                createdAt,
                elementCount: elements.length,
            });
        },
        blueprintDeleted(state, action: PayloadAction<string>) {
            state.blueprintIndex = state.blueprintIndex.filter((e) => e.id !== action.payload);
            if (state.pasteBlueprintId === action.payload) state.pasteBlueprintId = null;
        },
        startPaste(state, action: PayloadAction<string>) {
            state.pasteBlueprintId = action.payload;
            state.activeTool = "stamp";
            state.selectedIds = [];
        },
        cancelPaste(state) {
            state.pasteBlueprintId = null;
        },

        // ── Text tool ───────────────────────────────────────────────────────
        requestText(state, action: PayloadAction<WorldPoint>) {
            state.pendingTextPos = action.payload;
        },
        cancelText(state) {
            state.pendingTextPos = null;
        },

        setWorldFilterEnabled(state, action: PayloadAction<boolean>) {
            state.worldFilterEnabled = action.payload;
        },
    },
});

export const drawingActions = drawingSlice.actions;

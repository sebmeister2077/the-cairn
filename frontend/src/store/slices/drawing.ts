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
import { translateElement } from "@/lib/drawing/elements";
import { DEFAULT_STAMP_ICON_ID } from "@/lib/drawing/stampIcons";

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
/** Font families offered by the text tool (label + CSS stack). */
export const TEXT_FONTS: readonly { label: string; value: string }[] = [
    { label: "Sans", value: "ui-sans-serif, system-ui, sans-serif" },
    { label: "Serif", value: "ui-serif, Georgia, serif" },
    { label: "Mono", value: "ui-monospace, 'Courier New', monospace" },
    { label: "Rounded", value: "'Segoe UI', 'Trebuchet MS', sans-serif" },
];

export interface ToolStyle {
    /** Stroke colour for pen / shapes / text. */
    color: string;
    /** Pen / shape stroke width in world blocks. */
    widthBlocks: number;
    /** General draw opacity 0..1 applied to whatever you draw next (pen, lines,
     *  shape outlines, text, stamps). Marker keeps its own highlighter alpha. */
    opacity: number;
    /** Marker (highlighter) opacity 0..1. */
    markerOpacity: number;
    /** Pen toggles: draw a straight segment instead of free-hand, and/or cap the
     *  end with an arrowhead. Combinable (straight+arrow = a classic arrow). */
    penStraight: boolean;
    penArrow: boolean;
    /** Which primitive the Shapes tool draws. */
    shapeKind: "rect" | "roundedRect" | "circle";
    /** Corner radius (world blocks) for the rounded-rectangle shape. */
    cornerRadiusBlocks: number;
    /** Whether shapes are filled. */
    fillEnabled: boolean;
    fillColor: string;
    fillOpacity: number;
    textSizeBlocks: number;
    /** Text formatting. */
    textBold: boolean;
    textItalic: boolean;
    textFont: string;
    /** Outline (halo) behind text + stamps for legibility. */
    outlineEnabled: boolean;
    outlineColor: string;
    /** Vector stamp icon id (see stampIcons.ts). */
    stampIconId: string;
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
    /** Id of a text element being re-edited via the dialog, or null. */
    editingTextId: string | null;
    /** "This world only" board list filter. */
    worldFilterEnabled: boolean;
}

const DEFAULT_STYLE: ToolStyle = {
    color: "#dc2626",
    widthBlocks: 24,
    opacity: 1,
    markerOpacity: 0.4,
    penStraight: false,
    penArrow: false,
    shapeKind: "rect",
    cornerRadiusBlocks: 20,
    fillEnabled: false,
    fillColor: "#f59e0b",
    fillOpacity: 0.3,
    textSizeBlocks: 80,
    textBold: false,
    textItalic: false,
    textFont: TEXT_FONTS[0].value,
    outlineEnabled: true,
    outlineColor: "#000000",
    stampIconId: DEFAULT_STAMP_ICON_ID,
    stampSizeBlocks: 20,
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
    editingTextId: null,
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

/** Map relevant ToolStyle fields onto a single element (used by restyleSelected). */
function applyStyleToElement(el: DrawElement, s: Partial<ToolStyle>): DrawElement {
    switch (el.kind) {
        case "pen":
        case "marker": {
            const next = { ...el };
            if (s.color !== undefined) next.color = s.color;
            if (s.widthBlocks !== undefined) next.widthBlocks = s.widthBlocks;
            if (el.kind === "marker" && s.markerOpacity !== undefined) next.opacity = s.markerOpacity;
            if (el.kind === "pen" && s.opacity !== undefined) next.opacity = s.opacity;
            return next;
        }
        case "line":
        case "arrow": {
            const next = { ...el };
            if (s.color !== undefined) next.color = s.color;
            if (s.widthBlocks !== undefined) next.widthBlocks = s.widthBlocks;
            if (s.opacity !== undefined) next.opacity = s.opacity;
            return next;
        }
        case "rect":
        case "circle": {
            const next = { ...el };
            if (s.color !== undefined) next.strokeColor = s.color;
            if (s.widthBlocks !== undefined) next.strokeWidthBlocks = s.widthBlocks;
            if (s.opacity !== undefined) next.strokeOpacity = s.opacity;
            if (s.fillEnabled !== undefined || s.fillColor !== undefined) {
                const enabled = s.fillEnabled ?? next.fillColor !== null;
                next.fillColor = enabled ? (s.fillColor ?? next.fillColor ?? "#f59e0b") : null;
            }
            if (s.fillOpacity !== undefined) next.fillOpacity = s.fillOpacity;
            if (next.kind === "rect" && s.shapeKind !== undefined) {
                next.cornerRadiusBlocks =
                    s.shapeKind === "roundedRect" ? (s.cornerRadiusBlocks ?? next.cornerRadiusBlocks) : 0;
            }
            return next;
        }
        case "text": {
            const next = { ...el };
            if (s.color !== undefined) next.color = s.color;
            if (s.opacity !== undefined) next.opacity = s.opacity;
            if (s.textSizeBlocks !== undefined) next.sizeBlocks = s.textSizeBlocks;
            if (s.textBold !== undefined) next.bold = s.textBold;
            if (s.textItalic !== undefined) next.italic = s.textItalic;
            if (s.textFont !== undefined) next.fontFamily = s.textFont;
            if (s.outlineEnabled !== undefined) next.outline = s.outlineEnabled;
            if (s.outlineColor !== undefined) next.outlineColor = s.outlineColor;
            return next;
        }
        case "stamp": {
            const next = { ...el };
            if (s.color !== undefined) next.color = s.color;
            if (s.opacity !== undefined) next.opacity = s.opacity;
            if (s.stampIconId !== undefined) next.iconId = s.stampIconId;
            if (s.stampSizeBlocks !== undefined) next.sizeBlocks = s.stampSizeBlocks;
            if (s.outlineEnabled !== undefined) next.outline = s.outlineEnabled;
            if (s.outlineColor !== undefined) next.outlineColor = s.outlineColor;
            return next;
        }
    }
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
        /** Translate the given elements by (dx, dz) world blocks (drag-move). */
        moveElements(
            state,
            action: PayloadAction<{ ids: string[]; dx: number; dz: number }>,
        ) {
            const { ids, dx, dz } = action.payload;
            if (!state.activeBoard || ids.length === 0) return;
            if (dx === 0 && dz === 0) return;
            const set = new Set(ids);
            pushHistory(state);
            state.activeBoard.elements = state.activeBoard.elements.map((el) =>
                set.has(el.id) ? translateElement(el, dx, dz) : el,
            );
            touch(state);
        },
        /** Patch a single element in place (e.g. edited text content). */
        updateElement(
            state,
            action: PayloadAction<{ id: string; changes: Partial<DrawElement> }>,
        ) {
            if (!state.activeBoard) return;
            const { id, changes } = action.payload;
            const i = state.activeBoard.elements.findIndex((el) => el.id === id);
            if (i < 0) return;
            pushHistory(state);
            state.activeBoard.elements[i] = {
                ...state.activeBoard.elements[i],
                ...changes,
            } as DrawElement;
            touch(state);
        },
        /** Apply the current tool style to every selected element (per-kind). */
        restyleSelected(state, action: PayloadAction<Partial<ToolStyle>>) {
            if (!state.activeBoard || state.selectedIds.length === 0) return;
            const set = new Set(state.selectedIds);
            const s = action.payload;
            pushHistory(state);
            state.activeBoard.elements = state.activeBoard.elements.map((el) => {
                if (!set.has(el.id)) return el;
                return applyStyleToElement(el, s);
            });
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
        /** Open the edit dialog for an existing text element. */
        requestTextEdit(state, action: PayloadAction<string>) {
            state.editingTextId = action.payload;
        },
        cancelTextEdit(state) {
            state.editingTextId = null;
        },

        setWorldFilterEnabled(state, action: PayloadAction<boolean>) {
            state.worldFilterEnabled = action.payload;
        },
    },
});

export const drawingActions = drawingSlice.actions;

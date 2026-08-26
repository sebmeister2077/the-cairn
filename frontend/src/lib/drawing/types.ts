// Domain types for the TOPS map planning boards ("draw on the map") feature.
//
// Every geometric value is stored in WORLD coordinates (X/Z blocks, floats)
// and every thickness/size in WORLD BLOCKS, so drawings stay anchored to the
// terrain and scale with the map zoom (a blueprint painted on the ground).
// The screen projection happens at render time via the viewer's
// `projectWorld()` — nothing here knows about pixels.

/** Bumped when the persisted element/board shape changes incompatibly. Kept on
 *  each board + blueprint so a future backend sync and local migrations can
 *  reason about old payloads. */
export const DRAWING_SCHEMA_VERSION = 1;

export interface WorldPoint {
    x: number;
    z: number;
}

/** Free-hand tools share a polyline shape; `kind` selects the paint style
 *  (pen = opaque round stroke, marker = translucent highlighter). */
export interface StrokeElement {
    id: string;
    kind: "pen" | "marker";
    points: WorldPoint[];
    widthBlocks: number;
    color: string;
    opacity: number;
    /** Draw an arrowhead at the last point (free-hand pen with the arrow toggle). */
    arrow?: boolean;
    /** Layer this element belongs to (absent = the board's first/default layer). */
    layerId?: string;
    createdAt: number;
}

export interface LineElement {
    id: string;
    kind: "line" | "arrow";
    a: WorldPoint;
    b: WorldPoint;
    color: string;
    widthBlocks: number;
    opacity: number;
    layerId?: string;
    createdAt: number;
}

export interface RectElement {
    id: string;
    kind: "rect";
    a: WorldPoint;
    b: WorldPoint;
    strokeColor: string;
    strokeWidthBlocks: number;
    strokeOpacity: number;
    fillColor: string | null;
    fillOpacity: number;
    /** Corner radius in world blocks (0 / absent = square corners). */
    cornerRadiusBlocks?: number;
    /** Rotation about the element centre in radians (0 / absent = upright). */
    rotation?: number;
    layerId?: string;
    createdAt: number;
}

export interface CircleElement {
    id: string;
    kind: "circle";
    center: WorldPoint;
    radiusBlocks: number;
    strokeColor: string;
    strokeWidthBlocks: number;
    strokeOpacity: number;
    fillColor: string | null;
    fillOpacity: number;
    layerId?: string;
    createdAt: number;
}

/** Regular polygons + ellipse. All share a bounding box (`a`,`b`); the concrete
 *  vertices are derived from that box at render/hit-test time (see
 *  `polyVertices`), so resizing just moves the box corners. */
export type PolyShape =
    | "triangle"
    | "diamond"
    | "ellipse"
    | "pentagon"
    | "hexagon"
    | "octagon"
    | "star";

export interface PolyElement {
    id: string;
    kind: "poly";
    shape: PolyShape;
    a: WorldPoint;
    b: WorldPoint;
    strokeColor: string;
    strokeWidthBlocks: number;
    strokeOpacity: number;
    fillColor: string | null;
    fillOpacity: number;
    /** Rotation about the element centre in radians (0 / absent = upright). */
    rotation?: number;
    layerId?: string;
    createdAt: number;
}

export interface TextElement {
    id: string;
    kind: "text";
    pos: WorldPoint;
    text: string;
    sizeBlocks: number;
    color: string;
    opacity: number;
    /** Optional rich formatting (all default off / sans when absent). */
    bold?: boolean;
    italic?: boolean;
    fontFamily?: string;
    /** Draw a coloured outline (halo) behind the glyphs for legibility. */
    outline?: boolean;
    outlineColor?: string;
    /** Rotation about the element centre in radians (0 / absent = upright). */
    rotation?: number;
    layerId?: string;
    createdAt: number;
}

export interface StampElement {
    id: string;
    kind: "stamp";
    pos: WorldPoint;
    /** Vector icon id (see stampIcons.ts). New stamps use this. */
    iconId?: string;
    /** Tint colour for the vector icon. */
    color?: string;
    /** Legacy emoji character (older boards); rendered when no iconId. */
    glyph?: string;
    sizeBlocks: number;
    /** Draw alpha 0..1 (legacy stamps had no opacity → treated as 1). */
    opacity?: number;
    /** Draw a coloured outline behind the glyph. */
    outline?: boolean;
    outlineColor?: string;
    /** Rotation about the element centre in radians (0 / absent = upright). */
    rotation?: number;
    layerId?: string;
    createdAt: number;
}

export type DrawElement =
    | StrokeElement
    | LineElement
    | RectElement
    | CircleElement
    | PolyElement
    | TextElement
    | StampElement;

export type DrawElementKind = DrawElement["kind"];

/** What the Shapes tool can draw: box-based rect variants, a perfect circle, or
 *  any {@link PolyShape}. */
export type ShapeKind = "rect" | "roundedRect" | "circle" | PolyShape;

/** Every interactive mode the drawing surface can be in. `select` drives the
 *  marquee used to build blueprints; `eraser` removes whole elements. */
export type DrawTool =
    | "pen"
    | "marker"
    | "eraser"
    | "line"
    | "arrow"
    | "shape"
    | "rect"
    | "circle"
    | "text"
    | "stamp"
    | "select";

/** A drawing layer: an independent surface so elements on different layers
 *  don't interact (hidden layers aren't drawn; locked layers can't be edited). */
export interface Layer {
    id: string;
    name: string;
    visible: boolean;
    locked: boolean;
}

/** A planning board: one project's worth of drawings. */
export interface Board {
    id: string;
    name: string;
    /** Map host/seed the board was drawn on, for future "this world only"
     *  filtering. `null` = unscoped / legacy. */
    worldKey: string | null;
    elements: DrawElement[];
    /** Ordered bottom→top; index 0 is the default layer for legacy elements
     *  (those without a `layerId`). Always at least one entry after load. */
    layers: Layer[];
    /** Layer new elements are added to. */
    activeLayerId: string;
    createdAt: number;
    updatedAt: number;
    schemaVersion: number;
}

/** Create a fresh layer with sensible defaults. */
export function newLayer(name: string): Layer {
    return { id: newId(), name, visible: true, locked: false };
}

/** Ensure a board (possibly loaded from an older schema) has at least one
 *  layer + a valid active layer. Mutates + returns the same board. */
export function ensureBoardLayers(board: Board): Board {
    if (!board.layers || board.layers.length === 0) {
        board.layers = [newLayer("Layer 1")];
    }
    if (!board.activeLayerId || !board.layers.some((l) => l.id === board.activeLayerId)) {
        board.activeLayerId = board.layers[board.layers.length - 1].id;
    }
    return board;
}

/** Lightweight board summary kept in Redux + hydrated from IDB without loading
 *  every element up front. */
export interface BoardIndexEntry {
    id: string;
    name: string;
    worldKey: string | null;
    updatedAt: number;
    elementCount: number;
}

/** A reusable group of elements normalised so its bounding-box min sits at the
 *  local origin (0,0); pasting translates a fresh clone to a target world pos. */
export interface Blueprint {
    id: string;
    name: string;
    elements: DrawElement[];
    widthBlocks: number;
    heightBlocks: number;
    createdAt: number;
    schemaVersion: number;
}

export interface BlueprintIndexEntry {
    id: string;
    name: string;
    widthBlocks: number;
    heightBlocks: number;
    createdAt: number;
    elementCount: number;
}

export function newId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
        return crypto.randomUUID();
    }
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function boardIndexEntry(b: Board): BoardIndexEntry {
    return {
        id: b.id,
        name: b.name,
        worldKey: b.worldKey,
        updatedAt: b.updatedAt,
        elementCount: b.elements.length,
    };
}

export function blueprintIndexEntry(b: Blueprint): BlueprintIndexEntry {
    return {
        id: b.id,
        name: b.name,
        widthBlocks: b.widthBlocks,
        heightBlocks: b.heightBlocks,
        createdAt: b.createdAt,
        elementCount: b.elements.length,
    };
}

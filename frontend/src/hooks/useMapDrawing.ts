// Gesture controller for drawing planning-board elements onto the TOPS map.
//
// This owns only the in-progress gesture (the stroke/shape being dragged, the
// eraser's pending set, the marquee box). Committed elements live in Redux and
// are rendered by the viewer; here we expose getters (preview element, marquee
// rect, pending-erase set) plus pointer handlers. The viewer supplies world
// projection so all coordinate maths stays in one place.

import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { ToolStyle } from "@/store/slices/drawing";
import {
    type DrawElement,
    type DrawTool,
    type WorldPoint,
    newId,
} from "@/lib/drawing/types";
import {
    cloneElementWithNewId,
    elementInBox,
    elementResizeHandles,
    elementsBBox,
    hitTestElement,
    resizeElement,
    translateElement,
    type ResizeHandleId,
} from "@/lib/drawing/elements";

/** Screen-space marquee rectangle (container px). */
export interface MarqueeRect {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** Live offset applied to selected elements while a move drag is in progress. */
export interface MoveOffset {
    ids: ReadonlySet<string>;
    dx: number;
    dz: number;
}

type Gesture =
    | { type: "stroke"; el: Extract<DrawElement, { kind: "pen" | "marker" }> }
    | { type: "shape"; el: DrawElement }
    | { type: "erase"; ids: Set<string> }
    | { type: "marquee"; rect: MarqueeRect }
    | { type: "move"; ids: Set<string>; start: WorldPoint; cur: WorldPoint }
    | { type: "resize"; id: string; handle: ResizeHandleId; original: DrawElement; el: DrawElement };

export interface MapDrawingConfig {
    enabledRef: MutableRefObject<boolean>;
    toolRef: MutableRefObject<DrawTool>;
    styleRef: MutableRefObject<ToolStyle>;
    /** Normalised-to-origin blueprint being stamped, or null. */
    pasteRef: MutableRefObject<{ elements: DrawElement[] } | null>;
    /** Committed elements, for eraser / marquee hit-testing. */
    elementsRef: MutableRefObject<DrawElement[]>;
    /** Currently-selected element ids (drives drag-to-move in select mode). */
    selectedRef: MutableRefObject<ReadonlySet<string>>;
    ppbRef: MutableRefObject<number>;
    unproject: (sx: number, sy: number) => WorldPoint;
    scheduleRedraw: () => void;
    onCommit: (el: DrawElement) => void;
    onCommitMany: (els: DrawElement[]) => void;
    onErase: (ids: string[]) => void;
    onSelect: (ids: string[]) => void;
    /** Commit a drag-move of the given elements by (dx, dz) world blocks. */
    onMove: (ids: string[], dx: number, dz: number) => void;
    /** Commit a single element's resized geometry. */
    onResize: (el: DrawElement) => void;
    /** Ask the React layer to collect a text label for the given world point
     *  (opens the themed dialog); the caller commits the element on submit. */
    onRequestText: (world: WorldPoint) => void;
}

export interface MapDrawingController {
    /** Handle a draw-mode pointer press. Returns true if the gesture consumed
     *  the event (viewer should skip panning). */
    onPointerDown: (sx: number, sy: number) => boolean;
    onPointerMove: (sx: number, sy: number) => void;
    onPointerUp: () => void;
    cancel: () => void;
    isActive: () => boolean;
    getPreview: () => DrawElement | null;
    getMarquee: () => MarqueeRect | null;
    getPendingErase: () => ReadonlySet<string>;
    /** Live drag-move offset for selected elements, or null. */
    getMoveOffset: () => MoveOffset | null;
    /** Live resized element while a handle drag is in progress, or null. */
    getResizePreview: () => { id: string; el: DrawElement } | null;
}

function styleStroke(style: ToolStyle, kind: "pen" | "marker", first: WorldPoint) {
    return {
        id: newId(),
        kind,
        points: [first],
        widthBlocks: style.widthBlocks,
        color: style.color,
        opacity: kind === "marker" ? style.markerOpacity : style.opacity,
        // Free-hand pen may cap its end with an arrowhead (arrow toggle).
        arrow: kind === "pen" && style.penArrow ? true : undefined,
        createdAt: Date.now(),
    } as Extract<DrawElement, { kind: "pen" | "marker" }>;
}

/** Straight segment produced by the pen tool's "straight" toggle (an arrow when
 *  the arrow toggle is also on). */
function styleLine(style: ToolStyle, a: WorldPoint): DrawElement {
    return {
        id: newId(),
        kind: style.penArrow ? "arrow" : "line",
        a,
        b: a,
        color: style.color,
        widthBlocks: style.widthBlocks,
        opacity: style.opacity,
        createdAt: Date.now(),
    };
}

function styleShape(style: ToolStyle, tool: DrawTool, a: WorldPoint): DrawElement | null {
    const now = Date.now();
    const fill = style.fillEnabled ? style.fillColor : null;
    // The unified Shapes tool selects its primitive (rect variant, circle, or a
    // polygon/ellipse) from the style's shapeKind.
    if (tool === "shape") {
        const sk = style.shapeKind;
        if (sk === "circle") {
            return {
                id: newId(),
                kind: "circle",
                center: a,
                radiusBlocks: 0,
                strokeColor: style.color,
                strokeWidthBlocks: style.widthBlocks,
                strokeOpacity: style.opacity,
                fillColor: fill,
                fillOpacity: style.fillOpacity,
                createdAt: now,
            };
        }
        if (sk === "rect" || sk === "roundedRect") {
            return {
                id: newId(),
                kind: "rect",
                a,
                b: a,
                strokeColor: style.color,
                strokeWidthBlocks: style.widthBlocks,
                strokeOpacity: style.opacity,
                fillColor: fill,
                fillOpacity: style.fillOpacity,
                cornerRadiusBlocks: sk === "roundedRect" ? style.cornerRadiusBlocks : 0,
                createdAt: now,
            };
        }
        return {
            id: newId(),
            kind: "poly",
            shape: sk,
            a,
            b: a,
            strokeColor: style.color,
            strokeWidthBlocks: style.widthBlocks,
            strokeOpacity: style.opacity,
            fillColor: fill,
            fillOpacity: style.fillOpacity,
            createdAt: now,
        };
    }
    switch (tool) {
        case "line":
        case "arrow":
            return {
                id: newId(),
                kind: tool,
                a,
                b: a,
                color: style.color,
                widthBlocks: style.widthBlocks,
                opacity: style.opacity,
                createdAt: now,
            };
        case "rect":
            return {
                id: newId(),
                kind: "rect",
                a,
                b: a,
                strokeColor: style.color,
                strokeWidthBlocks: style.widthBlocks,
                strokeOpacity: style.opacity,
                fillColor: fill,
                fillOpacity: style.fillOpacity,
                cornerRadiusBlocks: 0,
                createdAt: now,
            };
        case "circle":
            return {
                id: newId(),
                kind: "circle",
                center: a,
                radiusBlocks: 0,
                strokeColor: style.color,
                strokeWidthBlocks: style.widthBlocks,
                strokeOpacity: style.opacity,
                fillColor: fill,
                fillOpacity: style.fillOpacity,
                createdAt: now,
            };
        default:
            return null;
    }
}

export function useMapDrawing(config: MapDrawingConfig): MapDrawingController {
    const cfg = useRef(config);
    useEffect(() => {
        cfg.current = config;
    });

    const gestureRef = useRef<Gesture | null>(null);
    const lastMarqueeRef = useRef<MarqueeRect | null>(null);

    /** World tolerance = ~6 screen px, so eraser/marquee feel consistent at any
     *  zoom. */
    const worldTol = useCallback(() => 6 / cfg.current.ppbRef.current, []);

    const eraseAt = useCallback((world: WorldPoint, ids: Set<string>) => {
        const tol = worldTol();
        for (const el of cfg.current.elementsRef.current) {
            if (ids.has(el.id)) continue;
            if (hitTestElement(el, world.x, world.z, tol)) ids.add(el.id);
        }
    }, [worldTol]);

    const onPointerDown = useCallback((sx: number, sy: number): boolean => {
        const c = cfg.current;
        if (!c.enabledRef.current) return false;
        const tool = c.toolRef.current;
        const world = c.unproject(sx, sy);

        // Paste mode: stamp a blueprint clone at the click and stay in mode.
        if (c.pasteRef.current) {
            const now = Date.now();
            const clones = c.pasteRef.current.elements.map((el) =>
                cloneElementWithNewId(translateElement(el, world.x, world.z), now),
            );
            c.onCommitMany(clones);
            return true;
        }

        switch (tool) {
            case "pen":
            case "marker": {
                // Pen with the "straight" toggle draws a line/arrow instead of a
                // free-hand stroke; everything else is a normal stroke.
                if (tool === "pen" && c.styleRef.current.penStraight) {
                    gestureRef.current = { type: "shape", el: styleLine(c.styleRef.current, world) };
                } else {
                    gestureRef.current = {
                        type: "stroke",
                        el: styleStroke(c.styleRef.current, tool, world),
                    };
                }
                c.scheduleRedraw();
                return true;
            }
            case "line":
            case "arrow":
            case "shape":
            case "rect":
            case "circle": {
                const el = styleShape(c.styleRef.current, tool, world);
                if (el) {
                    gestureRef.current = { type: "shape", el };
                    c.scheduleRedraw();
                }
                return true;
            }
            case "text": {
                c.onRequestText(world);
                return true;
            }
            case "stamp": {
                c.onCommit({
                    id: newId(),
                    kind: "stamp",
                    pos: world,
                    iconId: c.styleRef.current.stampIconId,
                    color: c.styleRef.current.color,
                    sizeBlocks: c.styleRef.current.stampSizeBlocks,
                    opacity: c.styleRef.current.opacity,
                    outline: c.styleRef.current.outlineEnabled,
                    outlineColor: c.styleRef.current.outlineColor,
                    createdAt: Date.now(),
                });
                return true;
            }
            case "eraser": {
                const ids = new Set<string>();
                eraseAt(world, ids);
                gestureRef.current = { type: "erase", ids };
                c.scheduleRedraw();
                return true;
            }
            case "select": {
                // If the press lands inside the current selection, drag-move it;
                // otherwise start a fresh marquee.
                const sel = c.selectedRef.current;
                if (sel.size > 0) {
                    const selected = c.elementsRef.current.filter((el) => sel.has(el.id));
                    // A single selected element exposes resize handles; grabbing
                    // one starts a resize (checked before move so corners win).
                    if (selected.length === 1) {
                        const handleTol = 9 / cfg.current.ppbRef.current;
                        const handles = elementResizeHandles(selected[0]);
                        let hit: ResizeHandleId | null = null;
                        let best = Infinity;
                        for (const h of handles) {
                            const d = Math.hypot(world.x - h.world.x, world.z - h.world.z);
                            if (d <= handleTol && d < best) {
                                best = d;
                                hit = h.id;
                            }
                        }
                        if (hit) {
                            gestureRef.current = {
                                type: "resize",
                                id: selected[0].id,
                                handle: hit,
                                original: selected[0],
                                el: selected[0],
                            };
                            c.scheduleRedraw();
                            return true;
                        }
                    }
                    const bb = elementsBBox(selected);
                    const tol = worldTol();
                    if (
                        bb &&
                        world.x >= bb.minX - tol &&
                        world.x <= bb.maxX + tol &&
                        world.z >= bb.minZ - tol &&
                        world.z <= bb.maxZ + tol
                    ) {
                        gestureRef.current = {
                            type: "move",
                            ids: new Set(sel),
                            start: world,
                            cur: world,
                        };
                        c.scheduleRedraw();
                        return true;
                    }
                }
                gestureRef.current = { type: "marquee", rect: { x0: sx, y0: sy, x1: sx, y1: sy } };
                c.scheduleRedraw();
                return true;
            }
        }
    }, [eraseAt, worldTol]);

    const onPointerMove = useCallback((sx: number, sy: number) => {
        const c = cfg.current;
        const g = gestureRef.current;
        if (!g) return;
        const world = c.unproject(sx, sy);
        switch (g.type) {
            case "stroke":
                g.el.points.push(world);
                break;
            case "shape": {
                const el = g.el;
                if (el.kind === "line" || el.kind === "arrow" || el.kind === "rect" || el.kind === "poly") {
                    el.b = world;
                } else if (el.kind === "circle") {
                    el.radiusBlocks = Math.hypot(world.x - el.center.x, world.z - el.center.z);
                }
                break;
            }
            case "erase":
                eraseAt(world, g.ids);
                break;
            case "marquee":
                g.rect.x1 = sx;
                g.rect.y1 = sy;
                break;
            case "move":
                g.cur = world;
                break;
            case "resize":
                g.el = resizeElement(g.original, g.handle, world);
                break;
        }
        c.scheduleRedraw();
    }, [eraseAt]);

    const commitMarquee = useCallback((rect: MarqueeRect) => {
        const c = cfg.current;
        const a = c.unproject(rect.x0, rect.y0);
        const b = c.unproject(rect.x1, rect.y1);
        const box = {
            minX: Math.min(a.x, b.x),
            maxX: Math.max(a.x, b.x),
            minZ: Math.min(a.z, b.z),
            maxZ: Math.max(a.z, b.z),
        };
        const ids = c.elementsRef.current.filter((el) => elementInBox(el, box)).map((el) => el.id);
        c.onSelect(ids);
    }, []);

    const onPointerUp = useCallback(() => {
        const c = cfg.current;
        const g = gestureRef.current;
        gestureRef.current = null;
        if (!g) return;
        switch (g.type) {
            case "stroke":
                if (g.el.points.length > 0) c.onCommit(g.el);
                break;
            case "shape": {
                const el = g.el;
                const degenerate =
                    (el.kind === "circle" && el.radiusBlocks < 0.5) ||
                    ((el.kind === "line" || el.kind === "arrow" || el.kind === "rect" || el.kind === "poly") &&
                        Math.hypot(el.b.x - el.a.x, el.b.z - el.a.z) < 0.5);
                if (!degenerate) c.onCommit(el);
                break;
            }
            case "erase":
                if (g.ids.size > 0) c.onErase(Array.from(g.ids));
                break;
            case "marquee":
                lastMarqueeRef.current = g.rect;
                commitMarquee(g.rect);
                break;
            case "move": {
                const dx = g.cur.x - g.start.x;
                const dz = g.cur.z - g.start.z;
                if (dx !== 0 || dz !== 0) c.onMove(Array.from(g.ids), dx, dz);
                break;
            }
            case "resize":
                if (g.el !== g.original) c.onResize(g.el);
                break;
        }
        c.scheduleRedraw();
    }, [commitMarquee]);

    const cancel = useCallback(() => {
        gestureRef.current = null;
        cfg.current.scheduleRedraw();
    }, []);

    return {
        onPointerDown,
        onPointerMove,
        onPointerUp,
        cancel,
        isActive: () => gestureRef.current !== null,
        getPreview: () => {
            const g = gestureRef.current;
            if (!g) return null;
            if (g.type === "stroke") return g.el;
            if (g.type === "shape") return g.el;
            return null;
        },
        getMarquee: () => (gestureRef.current?.type === "marquee" ? gestureRef.current.rect : null),
        getPendingErase: () =>
            gestureRef.current?.type === "erase" ? gestureRef.current.ids : EMPTY_SET,
        getMoveOffset: () => {
            const g = gestureRef.current;
            if (g?.type !== "move") return null;
            return { ids: g.ids, dx: g.cur.x - g.start.x, dz: g.cur.z - g.start.z };
        },
        getResizePreview: () => {
            const g = gestureRef.current;
            if (g?.type !== "resize") return null;
            return { id: g.id, el: g.el };
        },
    };
}

const EMPTY_SET: ReadonlySet<string> = new Set();

// Pure geometry/element helpers for planning-board drawings. All maths is in
// world blocks; screen-space hit-testing takes a `project` fn from the viewer.

import {
    type Blueprint,
    type DrawElement,
    type PolyShape,
    type WorldPoint,
    DRAWING_SCHEMA_VERSION,
    newId,
} from "./types";

export interface WorldBBox {
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
}

/** World-space vertices of a polygon shape inscribed in its bounding box.
 *  `ellipse` returns an empty array (rendered/tested as a true ellipse). */
export function polyVertices(shape: PolyShape, bb: WorldBBox): WorldPoint[] {
    const cx = (bb.minX + bb.maxX) / 2;
    const cz = (bb.minZ + bb.maxZ) / 2;
    const rx = (bb.maxX - bb.minX) / 2;
    const rz = (bb.maxZ - bb.minZ) / 2;
    switch (shape) {
        case "ellipse":
            return [];
        case "triangle":
            return [
                { x: cx, z: bb.minZ },
                { x: bb.maxX, z: bb.maxZ },
                { x: bb.minX, z: bb.maxZ },
            ];
        case "diamond":
            return [
                { x: cx, z: bb.minZ },
                { x: bb.maxX, z: cz },
                { x: cx, z: bb.maxZ },
                { x: bb.minX, z: cz },
            ];
        case "star": {
            const pts: WorldPoint[] = [];
            for (let i = 0; i < 10; i++) {
                const a = -Math.PI / 2 + (i * Math.PI) / 5;
                const f = i % 2 === 0 ? 1 : 0.5;
                pts.push({ x: cx + rx * f * Math.cos(a), z: cz + rz * f * Math.sin(a) });
            }
            return pts;
        }
        default: {
            const n = shape === "pentagon" ? 5 : shape === "hexagon" ? 6 : 8;
            const pts: WorldPoint[] = [];
            for (let i = 0; i < n; i++) {
                const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
                pts.push({ x: cx + rx * Math.cos(a), z: cz + rz * Math.sin(a) });
            }
            return pts;
        }
    }
}

/** Rough on-screen width of a text label in world blocks (no canvas metrics). */
function approxTextWidthBlocks(el: Extract<DrawElement, { kind: "text" }>): number {
    const perChar = el.sizeBlocks * (el.bold ? 0.62 : 0.55);
    return Math.max(el.sizeBlocks * 0.5, el.text.length * perChar);
}

/** Line-box height of a text label in world blocks. */
function textHeightBlocks(el: Extract<DrawElement, { kind: "text" }>): number {
    return el.sizeBlocks * 1.15;
}

/** All world points that define an element's extent (stroke vertices, shape
 *  corners, a circle's cardinal points, etc.). */
function elementPoints(el: DrawElement): WorldPoint[] {
    switch (el.kind) {
        case "pen":
        case "marker":
            return el.points;
        case "line":
        case "arrow":
            return [el.a, el.b];
        case "rect":
            return [el.a, el.b];
        case "poly":
            return [el.a, el.b];
        case "circle":
            return [
                { x: el.center.x - el.radiusBlocks, z: el.center.z },
                { x: el.center.x + el.radiusBlocks, z: el.center.z },
                { x: el.center.x, z: el.center.z - el.radiusBlocks },
                { x: el.center.x, z: el.center.z + el.radiusBlocks },
            ];
        case "text":
            // Anchor is the top-left (baseline top, align left).
            return [
                el.pos,
                { x: el.pos.x + approxTextWidthBlocks(el), z: el.pos.z + textHeightBlocks(el) },
            ];
        case "stamp": {
            // Icon/emoji is centred on `pos` and spans ~sizeBlocks.
            const half = el.sizeBlocks / 2;
            return [
                { x: el.pos.x - half, z: el.pos.z - half },
                { x: el.pos.x + half, z: el.pos.z + half },
            ];
        }
    }
}

export function elementBBox(el: DrawElement): WorldBBox {
    const pts = elementPoints(el);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.x > maxX) maxX = p.x;
        if (p.z > maxZ) maxZ = p.z;
    }
    return { minX, minZ, maxX, maxZ };
}

export function elementsBBox(els: DrawElement[]): WorldBBox | null {
    if (els.length === 0) return null;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const el of els) {
        const b = elementBBox(el);
        if (b.minX < minX) minX = b.minX;
        if (b.minZ < minZ) minZ = b.minZ;
        if (b.maxX > maxX) maxX = b.maxX;
        if (b.maxZ > maxZ) maxZ = b.maxZ;
    }
    return { minX, minZ, maxX, maxZ };
}

/** Return a translated copy of `el` (new object, SAME id). */
export function translateElement(el: DrawElement, dx: number, dz: number): DrawElement {
    const mv = (p: WorldPoint): WorldPoint => ({ x: p.x + dx, z: p.z + dz });
    switch (el.kind) {
        case "pen":
        case "marker":
            return { ...el, points: el.points.map(mv) };
        case "line":
        case "arrow":
            return { ...el, a: mv(el.a), b: mv(el.b) };
        case "rect":
            return { ...el, a: mv(el.a), b: mv(el.b) };
        case "poly":
            return { ...el, a: mv(el.a), b: mv(el.b) };
        case "circle":
            return { ...el, center: mv(el.center) };
        case "text":
        case "stamp":
            return { ...el, pos: mv(el.pos) };
    }
}

/** Deep-ish clone with a fresh id + timestamp (used when pasting blueprints). */
export function cloneElementWithNewId(el: DrawElement, createdAt: number): DrawElement {
    const base = { ...el, id: newId(), createdAt };
    if (base.kind === "pen" || base.kind === "marker") {
        return { ...base, points: base.points.map((p) => ({ ...p })) };
    }
    return base;
}

/** Even-odd point-in-polygon test in world units. */
function pointInPolygon(px: number, pz: number, verts: WorldPoint[]): boolean {
    let inside = false;
    for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
        const zi = verts[i].z;
        const zj = verts[j].z;
        const xi = verts[i].x;
        const xj = verts[j].x;
        const intersect =
            zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

/** Squared distance from point (px,pz) to segment a-b, in world units. */
function distSqToSegment(px: number, pz: number, a: WorldPoint, b: WorldPoint): number {
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const apx = px - a.x;
    const apz = pz - a.z;
    const lenSq = abx * abx + abz * abz;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, (apx * abx + apz * abz) / lenSq)) : 0;
    const cx = a.x + t * abx;
    const cz = a.z + t * abz;
    const dx = px - cx;
    const dz = pz - cz;
    return dx * dx + dz * dz;
}

/**
 * True if a world-space cursor is within `toleranceBlocks` of the element.
 * Uses outline distance for strokes/lines/rects/circles and bbox/centre
 * proximity for text/stamps. Eraser + marquee rely on this.
 */
export function hitTestElement(
    el: DrawElement,
    px: number,
    pz: number,
    toleranceBlocks: number,
): boolean {
    switch (el.kind) {
        case "pen":
        case "marker": {
            const half = el.widthBlocks / 2;
            const t = (toleranceBlocks + half) ** 2;
            for (let i = 1; i < el.points.length; i++) {
                if (distSqToSegment(px, pz, el.points[i - 1], el.points[i]) <= t) return true;
            }
            if (el.points.length === 1) {
                const p = el.points[0];
                return (px - p.x) ** 2 + (pz - p.z) ** 2 <= t;
            }
            return false;
        }
        case "line":
        case "arrow": {
            const half = el.widthBlocks / 2;
            return distSqToSegment(px, pz, el.a, el.b) <= (toleranceBlocks + half) ** 2;
        }
        case "rect": {
            const minX = Math.min(el.a.x, el.b.x);
            const maxX = Math.max(el.a.x, el.b.x);
            const minZ = Math.min(el.a.z, el.b.z);
            const maxZ = Math.max(el.a.z, el.b.z);
            // Filled rects are hit anywhere inside; outline-only rects only near
            // the border.
            if (el.fillColor) {
                return px >= minX - toleranceBlocks && px <= maxX + toleranceBlocks &&
                    pz >= minZ - toleranceBlocks && pz <= maxZ + toleranceBlocks;
            }
            const corners: WorldPoint[] = [
                { x: minX, z: minZ },
                { x: maxX, z: minZ },
                { x: maxX, z: maxZ },
                { x: minX, z: maxZ },
            ];
            const t = (toleranceBlocks + el.strokeWidthBlocks / 2) ** 2;
            for (let i = 0; i < 4; i++) {
                if (distSqToSegment(px, pz, corners[i], corners[(i + 1) % 4]) <= t) return true;
            }
            return false;
        }
        case "circle": {
            const d = Math.hypot(px - el.center.x, pz - el.center.z);
            if (el.fillColor) return d <= el.radiusBlocks + toleranceBlocks;
            return Math.abs(d - el.radiusBlocks) <= toleranceBlocks + el.strokeWidthBlocks / 2;
        }
        case "poly": {
            const bb = elementBBox(el);
            if (el.shape === "ellipse") {
                const cx = (bb.minX + bb.maxX) / 2;
                const cz = (bb.minZ + bb.maxZ) / 2;
                const rx = Math.max(1e-6, (bb.maxX - bb.minX) / 2);
                const rz = Math.max(1e-6, (bb.maxZ - bb.minZ) / 2);
                const nx = (px - cx) / rx;
                const nz = (pz - cz) / rz;
                if (el.fillColor) return nx * nx + nz * nz <= 1.1;
                const band = (toleranceBlocks + el.strokeWidthBlocks / 2) / Math.min(rx, rz);
                return Math.abs(Math.hypot(nx, nz) - 1) <= band;
            }
            const verts = polyVertices(el.shape, bb);
            if (el.fillColor && pointInPolygon(px, pz, verts)) return true;
            const t = (toleranceBlocks + el.strokeWidthBlocks / 2) ** 2;
            for (let i = 0; i < verts.length; i++) {
                if (distSqToSegment(px, pz, verts[i], verts[(i + 1) % verts.length]) <= t) return true;
            }
            return false;
        }
        case "text": {
            const w = approxTextWidthBlocks(el);
            const h = textHeightBlocks(el);
            return (
                px >= el.pos.x - toleranceBlocks &&
                px <= el.pos.x + w + toleranceBlocks &&
                pz >= el.pos.z - toleranceBlocks &&
                pz <= el.pos.z + h + toleranceBlocks
            );
        }
        case "stamp": {
            const half = el.sizeBlocks / 2 + toleranceBlocks;
            return (
                px >= el.pos.x - half &&
                px <= el.pos.x + half &&
                pz >= el.pos.z - half &&
                pz <= el.pos.z + half
            );
        }
    }
}

/** True if the element's bbox lies fully inside the selection rectangle. */
export function elementInBox(el: DrawElement, box: WorldBBox): boolean {
    const b = elementBBox(el);
    return b.minX >= box.minX && b.maxX <= box.maxX && b.minZ >= box.minZ && b.maxZ <= box.maxZ;
}

// ── Resize handles ──────────────────────────────────────────────────────────
// A single selected element exposes drag handles: line/arrow get endpoint
// handles, circles a radius handle on each cardinal, and everything else the
// eight bounding-box handles (corners + edge midpoints). Text/stamp scale
// uniformly (corners only); rects and strokes resize freely.

/** Handle ids: `a`/`b` = line endpoints; the rest are bbox anchors where the
 *  first letter(s) name the box side(s) the handle controls. */
export type ResizeHandleId =
    | "a"
    | "b"
    | "tl"
    | "t"
    | "tr"
    | "r"
    | "br"
    | "bl"
    | "l";

export interface ResizeHandle {
    id: ResizeHandleId;
    world: WorldPoint;
}

/** World-space handles for a single element (empty for kinds we don't resize). */
export function elementResizeHandles(el: DrawElement): ResizeHandle[] {
    switch (el.kind) {
        case "line":
        case "arrow":
            return [
                { id: "a", world: el.a },
                { id: "b", world: el.b },
            ];
        case "circle": {
            const { x, z } = el.center;
            const r = el.radiusBlocks;
            return [
                { id: "t", world: { x, z: z - r } },
                { id: "r", world: { x: x + r, z } },
                { id: "b", world: { x, z: z + r } },
                { id: "l", world: { x: x - r, z } },
            ];
        }
        default: {
            const bb = elementBBox(el);
            const midX = (bb.minX + bb.maxX) / 2;
            const midZ = (bb.minZ + bb.maxZ) / 2;
            const corners: ResizeHandle[] = [
                { id: "tl", world: { x: bb.minX, z: bb.minZ } },
                { id: "tr", world: { x: bb.maxX, z: bb.minZ } },
                { id: "br", world: { x: bb.maxX, z: bb.maxZ } },
                { id: "bl", world: { x: bb.minX, z: bb.maxZ } },
            ];
            // Text + stamps scale uniformly, so only corner handles are offered.
            if (el.kind === "text" || el.kind === "stamp") return corners;
            return [
                ...corners,
                { id: "t", world: { x: midX, z: bb.minZ } },
                { id: "r", world: { x: bb.maxX, z: midZ } },
                { id: "b", world: { x: midX, z: bb.maxZ } },
                { id: "l", world: { x: bb.minX, z: midZ } },
            ];
        }
    }
}

const MIN_RESIZE_BLOCKS = 1;

/** New bbox after dragging `handle` to `cursor`, keeping the opposite side fixed
 *  and clamping to a minimum so the box can't collapse or flip. */
function boxFromHandleDrag(
    box: WorldBBox,
    handle: ResizeHandleId,
    cursor: WorldPoint,
    uniform: boolean,
): WorldBBox {
    const controlsL = handle === "l" || handle === "tl" || handle === "bl";
    const controlsR = handle === "r" || handle === "tr" || handle === "br";
    const controlsT = handle === "t" || handle === "tl" || handle === "tr";
    const controlsB = handle === "b" || handle === "bl" || handle === "br";

    if (!uniform) {
        let { minX, minZ, maxX, maxZ } = box;
        if (controlsL) minX = Math.min(cursor.x, box.maxX - MIN_RESIZE_BLOCKS);
        if (controlsR) maxX = Math.max(cursor.x, box.minX + MIN_RESIZE_BLOCKS);
        if (controlsT) minZ = Math.min(cursor.z, box.maxZ - MIN_RESIZE_BLOCKS);
        if (controlsB) maxZ = Math.max(cursor.z, box.minZ + MIN_RESIZE_BLOCKS);
        return { minX, minZ, maxX, maxZ };
    }

    // Uniform: scale about the opposite corner, aspect locked to the original.
    const anchorX = controlsL ? box.maxX : box.minX;
    const anchorZ = controlsT ? box.maxZ : box.minZ;
    const ow = Math.max(1e-6, box.maxX - box.minX);
    const oh = Math.max(1e-6, box.maxZ - box.minZ);
    const s = Math.max(
        MIN_RESIZE_BLOCKS / Math.min(ow, oh),
        Math.abs(cursor.x - anchorX) / ow,
        Math.abs(cursor.z - anchorZ) / oh,
    );
    const nw = ow * s;
    const nh = oh * s;
    return {
        minX: controlsL ? anchorX - nw : anchorX,
        maxX: controlsL ? anchorX : anchorX + nw,
        minZ: controlsT ? anchorZ - nh : anchorZ,
        maxZ: controlsT ? anchorZ : anchorZ + nh,
    };
}

/** Map a point from the original bbox into the resized bbox (linear per-axis). */
function remapPoint(p: WorldPoint, ob: WorldBBox, nb: WorldBBox): WorldPoint {
    const ow = Math.max(1e-6, ob.maxX - ob.minX);
    const oh = Math.max(1e-6, ob.maxZ - ob.minZ);
    return {
        x: nb.minX + ((p.x - ob.minX) * (nb.maxX - nb.minX)) / ow,
        z: nb.minZ + ((p.z - ob.minZ) * (nb.maxZ - nb.minZ)) / oh,
    };
}

/**
 * Return a resized copy of `el` (same id) given the dragged handle and the
 * cursor's world position. `el` must be the element as it was when the drag
 * began, so scaling stays stable across the gesture.
 */
export function resizeElement(el: DrawElement, handle: ResizeHandleId, cursor: WorldPoint): DrawElement {
    switch (el.kind) {
        case "line":
        case "arrow":
            return handle === "a" ? { ...el, a: cursor } : { ...el, b: cursor };
        case "circle":
            return {
                ...el,
                radiusBlocks: Math.max(
                    MIN_RESIZE_BLOCKS,
                    Math.hypot(cursor.x - el.center.x, cursor.z - el.center.z),
                ),
            };
        default: {
            const uniform = el.kind === "text" || el.kind === "stamp";
            const ob = elementBBox(el);
            const nb = boxFromHandleDrag(ob, handle, cursor, uniform);
            const sx = (nb.maxX - nb.minX) / Math.max(1e-6, ob.maxX - ob.minX);
            const sz = (nb.maxZ - nb.minZ) / Math.max(1e-6, ob.maxZ - ob.minZ);
            switch (el.kind) {
                case "pen":
                case "marker":
                    return { ...el, points: el.points.map((p) => remapPoint(p, ob, nb)) };
                case "rect": {
                    const cr = el.cornerRadiusBlocks
                        ? el.cornerRadiusBlocks * Math.min(sx, sz)
                        : el.cornerRadiusBlocks;
                    return {
                        ...el,
                        a: remapPoint(el.a, ob, nb),
                        b: remapPoint(el.b, ob, nb),
                        cornerRadiusBlocks: cr,
                    };
                }
                case "poly":
                    return { ...el, a: remapPoint(el.a, ob, nb), b: remapPoint(el.b, ob, nb) };
                case "text":
                    return {
                        ...el,
                        pos: remapPoint(el.pos, ob, nb),
                        sizeBlocks: Math.max(4, el.sizeBlocks * ((sx + sz) / 2)),
                    };
                case "stamp":
                    return {
                        ...el,
                        pos: remapPoint(el.pos, ob, nb),
                        sizeBlocks: Math.max(4, el.sizeBlocks * ((sx + sz) / 2)),
                    };
                default:
                    return el;
            }
        }
    }
}

/**
 * Build a blueprint from a set of elements: normalise so the group's bbox min
 * sits at local origin (0,0) and record the bbox size for the paste ghost.
 */
export function makeBlueprint(name: string, els: DrawElement[], createdAt: number): Blueprint | null {
    const bbox = elementsBBox(els);
    if (!bbox) return null;
    const normalized = els.map((el) =>
        cloneElementWithNewId(translateElement(el, -bbox.minX, -bbox.minZ), createdAt),
    );
    return {
        id: newId(),
        name,
        elements: normalized,
        widthBlocks: bbox.maxX - bbox.minX,
        heightBlocks: bbox.maxZ - bbox.minZ,
        createdAt,
        schemaVersion: DRAWING_SCHEMA_VERSION,
    };
}

/**
 * Instantiate a blueprint at a target world position (its local origin lands on
 * `at`), returning freshly-id'd elements ready to append to a board.
 */
export function instantiateBlueprint(bp: Blueprint, at: WorldPoint, createdAt: number): DrawElement[] {
    return bp.elements.map((el) =>
        cloneElementWithNewId(translateElement(el, at.x, at.z), createdAt),
    );
}

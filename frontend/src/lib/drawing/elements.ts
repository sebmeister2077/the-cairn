// Pure geometry/element helpers for planning-board drawings. All maths is in
// world blocks; screen-space hit-testing takes a `project` fn from the viewer.

import {
    type Blueprint,
    type DrawElement,
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

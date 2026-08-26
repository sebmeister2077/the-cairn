// Canvas rendering for planning-board drawings. World coords are projected to
// screen via the viewer's `projectWorld`; thicknesses/sizes (world blocks) are
// multiplied by `pixelsPerBlock` so everything scales with zoom.

import type { DrawElement } from "./types";
import { elementBBox, polyVertices, translateElement } from "./elements";
import { STAMP_ICON_MAP, drawStampIcon } from "./stampIcons";

export type ProjectFn = (wx: number, wz: number) => { x: number; y: number };

export interface DrawElementsOptions {
    /** Element ids to outline as "selected" (marquee / blueprint source). */
    highlightIds?: ReadonlySet<string>;
    /** Draw everything at reduced alpha (paste ghost / in-progress preview). */
    ghost?: boolean;
    /** Live drag-move: translate matching elements by (dx, dz) world blocks. */
    moveOffset?: { ids: ReadonlySet<string>; dx: number; dz: number };
}

const MIN_LINE_PX = 1;

function applyAlpha(ctx: CanvasRenderingContext2D, alpha: number, ghost: boolean): void {
    ctx.globalAlpha = ghost ? alpha * 0.55 : alpha;
}

/** Arrowhead geometry: the barb spread angle and how far the head extends back
 *  from the tip (× the stroke width). Kept in one place so the line-shortening
 *  in the caller always matches the drawn head. */
const ARROW_SPREAD = Math.PI / 7;
const ARROW_LEN_FACTOR = 3.2;

function arrowHeadLen(lineWidthPx: number): number {
    return Math.max(8, lineWidthPx * ARROW_LEN_FACTOR);
}

/** Draw a filled arrowhead whose TIP sits exactly on (toX,toY), pointing along
 *  the from→to direction. */
function drawArrowHead(
    ctx: CanvasRenderingContext2D,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    lineWidthPx: number,
): void {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    const size = arrowHeadLen(lineWidthPx);
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - size * Math.cos(angle - ARROW_SPREAD), toY - size * Math.sin(angle - ARROW_SPREAD));
    ctx.lineTo(toX - size * Math.cos(angle + ARROW_SPREAD), toY - size * Math.sin(angle + ARROW_SPREAD));
    ctx.closePath();
    ctx.fill();
}

function drawOne(
    ctx: CanvasRenderingContext2D,
    el: DrawElement,
    project: ProjectFn,
    ppb: number,
    ghost: boolean,
): void {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    switch (el.kind) {
        case "pen":
        case "marker": {
            if (el.points.length === 0) return;
            const w = Math.max(MIN_LINE_PX, el.widthBlocks * ppb);
            applyAlpha(ctx, el.opacity, ghost);
            ctx.strokeStyle = el.color;
            ctx.lineWidth = w;
            ctx.beginPath();
            const p0 = project(el.points[0].x, el.points[0].z);
            ctx.moveTo(p0.x, p0.y);
            if (el.points.length === 1) {
                // A dot: draw a filled circle so a single tap is visible.
                ctx.fillStyle = el.color;
                ctx.beginPath();
                ctx.arc(p0.x, p0.y, w / 2, 0, Math.PI * 2);
                ctx.fill();
                break;
            }
            for (let i = 1; i < el.points.length; i++) {
                const p = project(el.points[i].x, el.points[i].z);
                ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
            // Optional arrowhead at the free-hand stroke's end.
            if (el.arrow && el.points.length >= 2) {
                const n = el.points.length;
                const from = project(el.points[n - 2].x, el.points[n - 2].z);
                const to = project(el.points[n - 1].x, el.points[n - 1].z);
                ctx.fillStyle = el.color;
                drawArrowHead(ctx, from.x, from.y, to.x, to.y, w);
            }
            break;
        }
        case "line":
        case "arrow": {
            const a = project(el.a.x, el.a.z);
            const b = project(el.b.x, el.b.z);
            const w = Math.max(MIN_LINE_PX, el.widthBlocks * ppb);
            applyAlpha(ctx, el.opacity, ghost);
            ctx.strokeStyle = el.color;
            ctx.fillStyle = el.color;
            ctx.lineWidth = w;
            // For arrows, stop the shaft at the base of the head so a round cap
            // doesn't poke through the tip (previously the head looked offset).
            let endX = b.x;
            let endY = b.y;
            if (el.kind === "arrow") {
                const len = Math.hypot(b.x - a.x, b.y - a.y);
                const back = arrowHeadLen(w) * Math.cos(ARROW_SPREAD);
                if (len > back) {
                    endX = b.x - (back * (b.x - a.x)) / len;
                    endY = b.y - (back * (b.y - a.y)) / len;
                }
            }
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(endX, endY);
            ctx.stroke();
            if (el.kind === "arrow") drawArrowHead(ctx, a.x, a.y, b.x, b.y, w);
            break;
        }
        case "rect": {
            const a = project(el.a.x, el.a.z);
            const b = project(el.b.x, el.b.z);
            const x = Math.min(a.x, b.x);
            const y = Math.min(a.y, b.y);
            const w = Math.abs(b.x - a.x);
            const h = Math.abs(b.y - a.y);
            const radius = el.cornerRadiusBlocks
                ? Math.min(el.cornerRadiusBlocks * ppb, w / 2, h / 2)
                : 0;
            const trace = () => {
                ctx.beginPath();
                if (radius > 0 && typeof ctx.roundRect === "function") {
                    ctx.roundRect(x, y, w, h, radius);
                } else {
                    ctx.rect(x, y, w, h);
                }
            };
            if (el.fillColor) {
                applyAlpha(ctx, el.fillOpacity, ghost);
                ctx.fillStyle = el.fillColor;
                trace();
                ctx.fill();
            }
            applyAlpha(ctx, el.strokeOpacity, ghost);
            ctx.strokeStyle = el.strokeColor;
            ctx.lineWidth = Math.max(MIN_LINE_PX, el.strokeWidthBlocks * ppb);
            trace();
            ctx.stroke();
            break;
        }
        case "circle": {
            const c = project(el.center.x, el.center.z);
            const r = Math.max(1, el.radiusBlocks * ppb);
            ctx.beginPath();
            ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
            if (el.fillColor) {
                applyAlpha(ctx, el.fillOpacity, ghost);
                ctx.fillStyle = el.fillColor;
                ctx.fill();
            }
            applyAlpha(ctx, el.strokeOpacity, ghost);
            ctx.strokeStyle = el.strokeColor;
            ctx.lineWidth = Math.max(MIN_LINE_PX, el.strokeWidthBlocks * ppb);
            ctx.stroke();
            break;
        }
        case "poly": {
            const a = project(el.a.x, el.a.z);
            const b = project(el.b.x, el.b.z);
            const minX = Math.min(a.x, b.x);
            const minY = Math.min(a.y, b.y);
            const w = Math.abs(b.x - a.x);
            const h = Math.abs(b.y - a.y);
            const trace = () => {
                ctx.beginPath();
                if (el.shape === "ellipse") {
                    ctx.ellipse(minX + w / 2, minY + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
                    return;
                }
                const verts = polyVertices(el.shape, {
                    minX: el.a.x < el.b.x ? el.a.x : el.b.x,
                    maxX: el.a.x > el.b.x ? el.a.x : el.b.x,
                    minZ: el.a.z < el.b.z ? el.a.z : el.b.z,
                    maxZ: el.a.z > el.b.z ? el.a.z : el.b.z,
                });
                verts.forEach((v, i) => {
                    const p = project(v.x, v.z);
                    if (i === 0) ctx.moveTo(p.x, p.y);
                    else ctx.lineTo(p.x, p.y);
                });
                ctx.closePath();
            };
            if (el.fillColor) {
                applyAlpha(ctx, el.fillOpacity, ghost);
                ctx.fillStyle = el.fillColor;
                trace();
                ctx.fill();
            }
            applyAlpha(ctx, el.strokeOpacity, ghost);
            ctx.strokeStyle = el.strokeColor;
            ctx.lineWidth = Math.max(MIN_LINE_PX, el.strokeWidthBlocks * ppb);
            trace();
            ctx.stroke();
            break;
        }
        case "text": {
            const p = project(el.pos.x, el.pos.z);
            const size = Math.max(6, el.sizeBlocks * ppb);
            applyAlpha(ctx, el.opacity, ghost);
            ctx.fillStyle = el.color;
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            const italic = el.italic ? "italic " : "";
            const weight = el.bold ? "700 " : "";
            const family = el.fontFamily ?? "ui-sans-serif, system-ui, sans-serif";
            ctx.font = `${italic}${weight}${size}px ${family}`;
            ctx.lineJoin = "round";
            // Halo for legibility over busy terrain (on by default for legacy text).
            if (el.outline ?? true) {
                ctx.strokeStyle = el.outlineColor ?? "rgba(0,0,0,0.55)";
                ctx.lineWidth = Math.max(1, size / 12);
                ctx.strokeText(el.text, p.x, p.y);
            }
            ctx.fillText(el.text, p.x, p.y);
            break;
        }
        case "stamp": {
            const p = project(el.pos.x, el.pos.z);
            const size = Math.max(8, el.sizeBlocks * ppb);
            applyAlpha(ctx, el.opacity ?? 1, ghost);
            const icon = el.iconId ? STAMP_ICON_MAP[el.iconId] : undefined;
            if (icon) {
                drawStampIcon(
                    ctx,
                    icon.node,
                    p.x,
                    p.y,
                    size,
                    el.color ?? "#dc2626",
                    el.outline ? { color: el.outlineColor ?? "#000000", width: 3 } : null,
                );
            } else if (el.glyph) {
                // Legacy emoji stamp (older boards).
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.font = `${size}px "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
                if (el.outline) {
                    ctx.strokeStyle = el.outlineColor ?? "#000000";
                    ctx.lineWidth = Math.max(1, size / 14);
                    ctx.lineJoin = "round";
                    ctx.strokeText(el.glyph, p.x, p.y);
                }
                ctx.fillText(el.glyph, p.x, p.y);
            }
            break;
        }
    }
}

/**
 * Paint a list of elements + an optional in-progress preview element onto the
 * drawing canvas (already cleared + DPR-scaled by the caller).
 */
export function drawElements(
    ctx: CanvasRenderingContext2D,
    elements: DrawElement[],
    project: ProjectFn,
    pixelsPerBlock: number,
    preview: DrawElement | null,
    opts: DrawElementsOptions = {},
): void {
    const { highlightIds, ghost = false, moveOffset } = opts;
    ctx.save();
    for (const src of elements) {
        const el =
            moveOffset && moveOffset.ids.has(src.id)
                ? translateElement(src, moveOffset.dx, moveOffset.dz)
                : src;
        drawOne(ctx, el, project, pixelsPerBlock, ghost);
        if (highlightIds && highlightIds.has(el.id)) {
            const bb = elementBBox(el);
            const tl = project(bb.minX, bb.minZ);
            const br = project(bb.maxX, bb.maxZ);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = "#38bdf8";
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(
                Math.min(tl.x, br.x) - 3,
                Math.min(tl.y, br.y) - 3,
                Math.abs(br.x - tl.x) + 6,
                Math.abs(br.y - tl.y) + 6,
            );
            ctx.setLineDash([]);
        }
    }
    if (preview) drawOne(ctx, preview, project, pixelsPerBlock, true);
    ctx.restore();
    ctx.globalAlpha = 1;
}

// Canvas rendering for planning-board drawings. World coords are projected to
// screen via the viewer's `projectWorld`; thicknesses/sizes (world blocks) are
// multiplied by `pixelsPerBlock` so everything scales with zoom.

import type { DrawElement } from "./types";
import { elementBBox, elementCenter, polyVertices, translateElement } from "./elements";
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

interface ScreenPoint {
    x: number;
    y: number;
}

/** Trim `trim` px off the end of a projected polyline, returning the shortened
 *  polyline plus the new tail point (the head's base). Used so a free-hand
 *  arrow's shaft stops under its head and the tip stays on the last point. */
function trimPolylineEnd(pts: ScreenPoint[], trim: number): { pts: ScreenPoint[]; tail: ScreenPoint } {
    let remaining = trim;
    for (let i = pts.length - 1; i > 0; i--) {
        const a = pts[i - 1];
        const b = pts[i];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        if (segLen >= remaining) {
            const t = (segLen - remaining) / segLen;
            const tail = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
            return { pts: [...pts.slice(0, i), tail], tail };
        }
        remaining -= segLen;
    }
    // Whole stroke is shorter than the head: collapse to the first point.
    return { pts: [pts[0]], tail: pts[0] };
}

/** Draw a filled arrowhead whose TIP sits exactly on (toX,toY), pointing along
 *  the from→to direction. Pass `alsoStroke` to trace the outline too (used to
 *  enlarge the head by the current lineWidth for a halo). */
function drawArrowHead(
    ctx: CanvasRenderingContext2D,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    lineWidthPx: number,
    alsoStroke = false,
): void {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    const size = arrowHeadLen(lineWidthPx);
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - size * Math.cos(angle - ARROW_SPREAD), toY - size * Math.sin(angle - ARROW_SPREAD));
    ctx.lineTo(toX - size * Math.cos(angle + ARROW_SPREAD), toY - size * Math.sin(angle + ARROW_SPREAD));
    ctx.closePath();
    ctx.fill();
    if (alsoStroke) ctx.stroke();
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
            const pts = el.points.map((p) => project(p.x, p.z));
            // A coloured halo behind the stroke for legibility (pen only).
            const outline = el.kind === "pen" && Boolean(el.outline);
            const haloColor = el.outlineColor ?? "rgba(0,0,0,0.55)";
            const halo = Math.max(2, w * 0.4);
            if (pts.length === 1) {
                // A dot: draw a filled circle so a single tap is visible.
                if (outline) {
                    applyAlpha(ctx, el.opacity, ghost);
                    ctx.fillStyle = haloColor;
                    ctx.beginPath();
                    ctx.arc(pts[0].x, pts[0].y, w / 2 + halo, 0, Math.PI * 2);
                    ctx.fill();
                }
                applyAlpha(ctx, el.opacity, ghost);
                ctx.fillStyle = el.color;
                ctx.beginPath();
                ctx.arc(pts[0].x, pts[0].y, w / 2, 0, Math.PI * 2);
                ctx.fill();
                break;
            }
            const withArrow = Boolean(el.arrow) && pts.length >= 2;
            const tip = pts[pts.length - 1];
            // For an arrow, stop the polyline at the head's base (like the
            // straight arrow) so the round cap sits *under* the head and the tip
            // lands exactly on the last point — not short of it.
            const base = withArrow
                ? trimPolylineEnd(pts, arrowHeadLen(w) * Math.cos(ARROW_SPREAD))
                : { pts, tail: tip };
            const traceShaft = () => {
                ctx.beginPath();
                ctx.moveTo(base.pts[0].x, base.pts[0].y);
                for (let i = 1; i < base.pts.length; i++) ctx.lineTo(base.pts[i].x, base.pts[i].y);
                ctx.stroke();
            };
            if (outline) {
                applyAlpha(ctx, el.opacity, ghost);
                ctx.strokeStyle = haloColor;
                ctx.fillStyle = haloColor;
                ctx.lineWidth = w + halo * 2;
                traceShaft();
                if (withArrow) {
                    // Enlarge the head by the halo width (fill + stroke same path).
                    ctx.lineWidth = halo * 2;
                    drawArrowHead(ctx, base.tail.x, base.tail.y, tip.x, tip.y, w, true);
                }
            }
            applyAlpha(ctx, el.opacity, ghost);
            ctx.strokeStyle = el.color;
            ctx.lineWidth = w;
            traceShaft();
            if (withArrow) {
                ctx.fillStyle = el.color;
                drawArrowHead(ctx, base.tail.x, base.tail.y, tip.x, tip.y, w);
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
            const rotation = el.rotation ?? 0;
            const a = project(el.a.x, el.a.z);
            const b = project(el.b.x, el.b.z);
            const w = Math.abs(b.x - a.x);
            const h = Math.abs(b.y - a.y);
            const radius = el.cornerRadiusBlocks
                ? Math.min(el.cornerRadiusBlocks * ppb, w / 2, h / 2)
                : 0;
            let x = Math.min(a.x, b.x);
            let y = Math.min(a.y, b.y);
            // Rotated rects draw in a centred, rotated frame; upright ones keep
            // the plain top-left path.
            if (rotation) {
                const c = elementCenter(el);
                const cs = project(c.x, c.z);
                ctx.save();
                ctx.translate(cs.x, cs.y);
                ctx.rotate(rotation);
                x = -w / 2;
                y = -h / 2;
            }
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
            if (rotation) ctx.restore();
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
            const w = Math.abs(b.x - a.x);
            const h = Math.abs(b.y - a.y);
            const c = elementCenter(el);
            const cs = project(c.x, c.z);
            // Draw in a centred frame so rotation is a simple ctx.rotate; the
            // polygon vertices are taken from a box centred at the origin.
            ctx.save();
            ctx.translate(cs.x, cs.y);
            const rotation = el.rotation ?? 0;
            if (rotation) ctx.rotate(rotation);
            const trace = () => {
                ctx.beginPath();
                if (el.shape === "ellipse") {
                    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
                    return;
                }
                const verts = polyVertices(el.shape, {
                    minX: -w / 2,
                    maxX: w / 2,
                    minZ: -h / 2,
                    maxZ: h / 2,
                });
                verts.forEach((v, i) => {
                    if (i === 0) ctx.moveTo(v.x, v.z);
                    else ctx.lineTo(v.x, v.z);
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
            ctx.restore();
            break;
        }
        case "text": {
            const rotation = el.rotation ?? 0;
            const size = Math.max(6, el.sizeBlocks * ppb);
            applyAlpha(ctx, el.opacity, ghost);
            ctx.fillStyle = el.color;
            const italic = el.italic ? "italic " : "";
            const weight = el.bold ? "700 " : "";
            const family = el.fontFamily ?? "ui-sans-serif, system-ui, sans-serif";
            ctx.font = `${italic}${weight}${size}px ${family}`;
            ctx.lineJoin = "round";
            let originX: number;
            let originY: number;
            if (rotation) {
                // Draw centred + rotated about the element centre.
                const c = elementCenter(el);
                const cs = project(c.x, c.z);
                ctx.save();
                ctx.translate(cs.x, cs.y);
                ctx.rotate(rotation);
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                originX = 0;
                originY = 0;
            } else {
                const p = project(el.pos.x, el.pos.z);
                ctx.textAlign = "left";
                ctx.textBaseline = "top";
                originX = p.x;
                originY = p.y;
            }
            // Halo for legibility over busy terrain (on by default for legacy text).
            if (el.outline ?? true) {
                ctx.strokeStyle = el.outlineColor ?? "rgba(0,0,0,0.55)";
                ctx.lineWidth = Math.max(1, size / 12);
                ctx.strokeText(el.text, originX, originY);
            }
            ctx.fillText(el.text, originX, originY);
            if (rotation) ctx.restore();
            break;
        }
        case "stamp": {
            const rotation = el.rotation ?? 0;
            const size = Math.max(8, el.sizeBlocks * ppb);
            applyAlpha(ctx, el.opacity ?? 1, ghost);
            const p = project(el.pos.x, el.pos.z);
            let ox = p.x;
            let oy = p.y;
            if (rotation) {
                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(rotation);
                ox = 0;
                oy = 0;
            }
            const icon = el.iconId ? STAMP_ICON_MAP[el.iconId] : undefined;
            if (icon) {
                drawStampIcon(
                    ctx,
                    icon.node,
                    ox,
                    oy,
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
                    ctx.strokeText(el.glyph, ox, oy);
                }
                ctx.fillText(el.glyph, ox, oy);
            }
            if (rotation) ctx.restore();
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

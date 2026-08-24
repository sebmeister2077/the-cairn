// Canvas rendering for planning-board drawings. World coords are projected to
// screen via the viewer's `projectWorld`; thicknesses/sizes (world blocks) are
// multiplied by `pixelsPerBlock` so everything scales with zoom.

import type { DrawElement } from "./types";
import { elementBBox, translateElement } from "./elements";
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

function drawArrowHead(
    ctx: CanvasRenderingContext2D,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    lineWidthPx: number,
): void {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    const size = Math.max(8, lineWidthPx * 3.2);
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - size * Math.cos(angle - Math.PI / 7), toY - size * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(toX - size * Math.cos(angle + Math.PI / 7), toY - size * Math.sin(angle + Math.PI / 7));
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
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
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
            if (el.fillColor) {
                applyAlpha(ctx, el.fillOpacity, ghost);
                ctx.fillStyle = el.fillColor;
                ctx.fillRect(x, y, w, h);
            }
            applyAlpha(ctx, el.strokeOpacity, ghost);
            ctx.strokeStyle = el.strokeColor;
            ctx.lineWidth = Math.max(MIN_LINE_PX, el.strokeWidthBlocks * ppb);
            ctx.strokeRect(x, y, w, h);
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

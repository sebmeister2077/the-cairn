/**
 * Marker icon styles (Trader / Translocator / Terminus).
 *
 * Houses pure canvas draw helpers for the three special marker kinds so
 * the rendering code in `MapViewer` stays focused on layout/projection.
 *
 * The chosen variants (locked in after a dev-only A/B panel — see git
 * history for `MarkerStyleDevPanel`) are:
 *   - Trader        → `"gear-stack"`  (rusty gears == VS in-game currency)
 *   - Translocator  → `"spiral"`      (portal-like inward swirl)
 *   - Terminus      → `"tombstone"`   (gravestone silhouette)
 *
 * Additional variants are kept in the switch statements so they can be
 * compared again later without re-implementing them.
 */

// ---------------------------------------------------------------------------
// Style variants
// ---------------------------------------------------------------------------

export type TraderStyle =
    | "dot"
    | "coin"
    | "bag"
    | "gear"
    | "gear-stack"
    | "rusty-gear";
export type TLStyle =
    | "portal"
    | "diamond"
    | "hex"
    | "spiral"
    | "dual-spiral"
    | "vortex";
export type TerminusStyle =
    | "skull"
    | "down-arrow"
    | "spiral"
    | "tombstone"
    | "cross"
    | "rift";

// ---------------------------------------------------------------------------
// Canvas draw helpers
// ---------------------------------------------------------------------------
//
// All helpers draw in image-space pixels and divide visible sizes by `zoom`
// (when zoom is provided) so the icon stays roughly the same size on screen.
// For the dev-panel swatches we pass `zoom = 1` and a fixed `baseSize`.
// ---------------------------------------------------------------------------

const OUTLINE = "rgba(15, 23, 42, 0.9)";

/** Size policy shared with MapViewer's existing trader/TL dots. */
function tlSize(zoom: number) {
    const outer = Math.max(2.1, 3.6 / Math.max(zoom, 0.1));
    return { outer, inner: Math.max(1, outer * 0.48) };
}

function traderSize(zoom: number) {
    const outer = Math.max(2.4, 4.0 / Math.max(zoom, 0.1));
    const stroke = Math.max(0.4, 0.8 / Math.max(zoom, 0.1));
    return { outer, stroke };
}

function terminusSize(zoom: number) {
    const outer = Math.max(3.0, 5.0 / Math.max(zoom, 0.1));
    const stroke = Math.max(0.4, 0.8 / Math.max(zoom, 0.1));
    return { outer, stroke };
}

// ---- Trader -------------------------------------------------------------

export function drawTraderMarker(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    zoom: number,
    style: TraderStyle,
    color: string,
) {
    const { outer, stroke } = traderSize(zoom);
    ctx.lineWidth = stroke;
    ctx.strokeStyle = OUTLINE;
    ctx.fillStyle = color;

    if (style === "dot") {
        ctx.beginPath();
        ctx.arc(x, y, outer, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        return;
    }

    if (style === "coin") {
        // Outer disc
        ctx.beginPath();
        ctx.arc(x, y, outer, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Inner ring (lighter rim)
        ctx.beginPath();
        ctx.arc(x, y, outer * 0.62, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.lineWidth = Math.max(0.3, stroke * 0.8);
        ctx.stroke();
        // Currency cross (small +)
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = Math.max(0.4, stroke * 1.1);
        const arm = outer * 0.45;
        ctx.beginPath();
        ctx.moveTo(x - arm, y);
        ctx.lineTo(x + arm, y);
        ctx.moveTo(x, y - arm);
        ctx.lineTo(x, y + arm);
        ctx.stroke();
        return;
    }

    if (style === "bag") {
        // Sack: rounded body + cinched neck triangle on top.
        const w = outer * 1.6;
        const h = outer * 1.7;
        const left = x - w / 2;
        const top = y - h * 0.35;
        const bodyTop = y - h * 0.15;
        const r = outer * 0.55;
        ctx.beginPath();
        // Cinched neck
        ctx.moveTo(x - outer * 0.45, top);
        ctx.lineTo(x + outer * 0.45, top);
        ctx.lineTo(x + outer * 0.7, bodyTop);
        // Right side
        ctx.lineTo(left + w, y + h * 0.5 - r);
        ctx.quadraticCurveTo(left + w, y + h * 0.5, left + w - r, y + h * 0.5);
        // Bottom
        ctx.lineTo(left + r, y + h * 0.5);
        ctx.quadraticCurveTo(left, y + h * 0.5, left, y + h * 0.5 - r);
        // Left side back up
        ctx.lineTo(x - outer * 0.7, bodyTop);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Currency mark on the bag
        ctx.fillStyle = OUTLINE;
        ctx.font = `bold ${outer * 1.1}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("$", x, y + outer * 0.18);
        return;
    }

    if (style === "gear") {
        drawGear(ctx, x, y, outer, stroke, color, OUTLINE, /*hubTone*/ "rust");
        return;
    }

    if (style === "gear-stack") {
        // Back gear: smaller, offset up-right, slightly darker tone.
        const back = outer * 0.78;
        drawGear(
            ctx,
            x + outer * 0.55,
            y - outer * 0.55,
            back,
            stroke,
            shadeColor(color, -0.18),
            OUTLINE,
            "rust",
        );
        // Front gear: full size at center.
        drawGear(ctx, x, y, outer, stroke, color, OUTLINE, "rust");
        return;
    }

    if (style === "rusty-gear") {
        // Same gear silhouette but with a clearly rust-tinted hub for the
        // "rusty gear" reading. Outer teeth keep the trader's color.
        drawGear(ctx, x, y, outer, stroke, color, OUTLINE, "heavy-rust");
        return;
    }
}

/**
 * Draws an 8-tooth gear silhouette centered at (x, y) with outer radius `r`.
 * The teeth are trapezoidal so the shape still reads as a gear at tiny sizes.
 * `hubTone` controls the inner-hub coloring:
 *  - "rust": muted rust ring + dark center hole
 *  - "heavy-rust": deeper rust ring (used by the "rusty-gear" variant)
 */
function drawGear(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    stroke: number,
    fill: string,
    outline: string,
    hubTone: "rust" | "heavy-rust",
) {
    const teeth = 8;
    const innerR = r * 0.78; // root circle (between teeth)
    const toothHalfWidth = (Math.PI / teeth) * 0.42; // angular half-width of each tooth

    ctx.fillStyle = fill;
    ctx.strokeStyle = outline;
    ctx.lineWidth = stroke;
    ctx.beginPath();
    for (let i = 0; i < teeth; i++) {
        const center = (i / teeth) * Math.PI * 2 - Math.PI / 2;
        // Tooth: out-left, out-right; then root-right, then next root-left.
        const a1 = center - toothHalfWidth;
        const a2 = center + toothHalfWidth;
        const a3 = center + Math.PI / teeth - toothHalfWidth * 0.6;
        if (i === 0) ctx.moveTo(x + Math.cos(a1) * r, y + Math.sin(a1) * r);
        else ctx.lineTo(x + Math.cos(a1) * r, y + Math.sin(a1) * r);
        ctx.lineTo(x + Math.cos(a2) * r, y + Math.sin(a2) * r);
        ctx.lineTo(x + Math.cos(a2) * innerR, y + Math.sin(a2) * innerR);
        ctx.lineTo(x + Math.cos(a3) * innerR, y + Math.sin(a3) * innerR);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Inner hub ring — rust tint for the "rusty gear" feel.
    const hubR = r * 0.42;
    ctx.fillStyle =
        hubTone === "heavy-rust" ? "rgba(120, 53, 28, 0.95)" : "rgba(146, 78, 46, 0.85)";
    ctx.beginPath();
    ctx.arc(x, y, hubR, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(0.3, stroke * 0.8);
    ctx.strokeStyle = outline;
    ctx.stroke();

    // Center axle hole.
    ctx.fillStyle = outline;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.6, r * 0.15), 0, Math.PI * 2);
    ctx.fill();
}

/**
 * Returns the same color shaded by `amount` (-1 darkens to black, +1 lightens
 * to white). Accepts `#rgb`, `#rrggbb`, or `rgb()/rgba()` strings. Anything
 * unrecognized falls back to the input.
 */
function shadeColor(color: string, amount: number): string {
    const clamp = (v: number) => Math.max(0, Math.min(255, v));
    const mix = (c: number) =>
        amount >= 0 ? clamp(c + (255 - c) * amount) : clamp(c + c * amount);

    // #rgb / #rrggbb
    if (color.startsWith("#")) {
        let hex = color.slice(1);
        if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
        if (hex.length !== 6) return color;
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return `rgb(${Math.round(mix(r))}, ${Math.round(mix(g))}, ${Math.round(mix(b))})`;
    }

    // rgb() / rgba()
    const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)/i);
    if (m) {
        const r = Number(m[1]);
        const g = Number(m[2]);
        const b = Number(m[3]);
        const a = m[4] !== undefined ? Number(m[4]) : 1;
        return `rgba(${Math.round(mix(r))}, ${Math.round(mix(g))}, ${Math.round(mix(b))}, ${a})`;
    }

    return color;
}

// ---- Translocator endpoint ---------------------------------------------

const PORTAL_INNER = "rgba(221, 214, 254, 0.98)";

export function drawTLEndpoint(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    zoom: number,
    style: TLStyle,
    outerColor: string,
) {
    const { outer, inner } = tlSize(zoom);
    const stroke = Math.max(0.4, 0.8 / Math.max(zoom, 0.1));

    if (style === "portal") {
        ctx.fillStyle = outerColor;
        ctx.beginPath();
        ctx.arc(x, y, outer, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = PORTAL_INNER;
        ctx.beginPath();
        ctx.arc(x, y, inner, 0, Math.PI * 2);
        ctx.fill();
        return;
    }

    if (style === "diamond") {
        const r = outer * 1.25;
        ctx.fillStyle = outerColor;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = stroke;
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Double-arrow horizontal
        ctx.strokeStyle = PORTAL_INNER;
        ctx.lineWidth = Math.max(0.5, stroke * 1.4);
        const a = r * 0.55;
        ctx.beginPath();
        ctx.moveTo(x - a, y);
        ctx.lineTo(x + a, y);
        // Left head
        ctx.moveTo(x - a + a * 0.4, y - a * 0.35);
        ctx.lineTo(x - a, y);
        ctx.lineTo(x - a + a * 0.4, y + a * 0.35);
        // Right head
        ctx.moveTo(x + a - a * 0.4, y - a * 0.35);
        ctx.lineTo(x + a, y);
        ctx.lineTo(x + a - a * 0.4, y + a * 0.35);
        ctx.stroke();
        return;
    }

    if (style === "hex") {
        const r = outer * 1.3;
        ctx.fillStyle = outerColor;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = stroke;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 3) * i - Math.PI / 2;
            const px = x + Math.cos(a) * r;
            const py = y + Math.sin(a) * r;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Double chevron (two stacked ^ symbols rotated to be horizontal)
        ctx.strokeStyle = PORTAL_INNER;
        ctx.lineWidth = Math.max(0.5, stroke * 1.4);
        const c = r * 0.45;
        ctx.beginPath();
        ctx.moveTo(x - c, y - c * 0.4);
        ctx.lineTo(x, y);
        ctx.lineTo(x - c, y + c * 0.4);
        ctx.moveTo(x, y - c * 0.4);
        ctx.lineTo(x + c, y);
        ctx.lineTo(x, y + c * 0.4);
        ctx.stroke();
        return;
    }

    if (style === "spiral") {
        // Filled disc backdrop + inward spiral. Single-spiral reads "portal"
        // without committing to the death/red palette Terminus uses.
        const r = outer * 1.25;
        ctx.fillStyle = outerColor;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = stroke;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        drawSpiralPath(ctx, x, y, r * 0.78, 1.6, PORTAL_INNER, Math.max(0.5, stroke * 1.3));
        return;
    }

    if (style === "dual-spiral") {
        // Two interlocking spirals side-by-side inside one disc — visually
        // reinforces the "paired endpoints" semantic of a translocator.
        const r = outer * 1.35;
        ctx.fillStyle = outerColor;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = stroke;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        const off = r * 0.42;
        const sr = r * 0.45;
        const sw = Math.max(0.45, stroke * 1.2);
        drawSpiralPath(ctx, x - off, y, sr, 1.2, PORTAL_INNER, sw);
        // Second spiral wound the opposite direction (negative turns).
        drawSpiralPath(ctx, x + off, y, sr, -1.2, PORTAL_INNER, sw);
        return;
    }

    if (style === "vortex") {
        // Concentric swirl arcs (3 nested 270° arcs at decreasing radii, each
        // rotated 90° from the last). Reads as a rotating portal.
        const r = outer * 1.3;
        ctx.fillStyle = outerColor;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = stroke;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = PORTAL_INNER;
        ctx.lineCap = "round";
        const arcs = 3;
        for (let i = 0; i < arcs; i++) {
            const ar = r * (0.75 - i * 0.22);
            if (ar <= 0) break;
            const start = (-Math.PI / 2) + i * (Math.PI / 2);
            const end = start + Math.PI * 1.5;
            ctx.lineWidth = Math.max(0.4, stroke * (1.4 - i * 0.25));
            ctx.beginPath();
            ctx.arc(x, y, ar, start, end);
            ctx.stroke();
        }
        return;
    }
}

/**
 * Draws an Archimedean spiral centered at (x, y) winding inward from radius
 * `rMax` over `turns` rotations. Negative `turns` reverses the winding
 * direction (useful for the dual-spiral variant).
 */
function drawSpiralPath(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    rMax: number,
    turns: number,
    color: string,
    lineWidth: number,
) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const angle = t * turns * Math.PI * 2;
        const r = rMax * (1 - t);
        const px = x + Math.cos(angle) * r;
        const py = y + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }
    ctx.stroke();
}

// ---- Terminus ----------------------------------------------------------

const TERMINUS_FILL = "rgba(194, 69, 58, 0.95)";
const TERMINUS_INNER = "rgba(254, 226, 226, 0.98)";

function tracePathHex(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        const px = x + Math.cos(a) * r;
        const py = y + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }
    ctx.closePath();
}

export function drawTerminusMarker(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    zoom: number,
    style: TerminusStyle,
) {
    const { outer, stroke } = terminusSize(zoom);

    if (style === "skull") {
        tracePathHex(ctx, x, y, outer);
        ctx.fillStyle = TERMINUS_FILL;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = stroke;
        ctx.fill();
        ctx.stroke();
        // Tiny skull: round head + two eye dots + jaw line
        ctx.fillStyle = TERMINUS_INNER;
        ctx.beginPath();
        ctx.arc(x, y - outer * 0.1, outer * 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = OUTLINE;
        const eye = outer * 0.1;
        ctx.beginPath();
        ctx.arc(x - outer * 0.18, y - outer * 0.12, eye, 0, Math.PI * 2);
        ctx.arc(x + outer * 0.18, y - outer * 0.12, eye, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = Math.max(0.3, stroke * 0.9);
        ctx.beginPath();
        ctx.moveTo(x - outer * 0.18, y + outer * 0.15);
        ctx.lineTo(x + outer * 0.18, y + outer * 0.15);
        ctx.stroke();
        return;
    }

    if (style === "down-arrow") {
        tracePathHex(ctx, x, y, outer);
        ctx.fillStyle = TERMINUS_FILL;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = stroke;
        ctx.fill();
        ctx.stroke();
        // Single downward arrow (one-way semantics).
        ctx.strokeStyle = TERMINUS_INNER;
        ctx.lineWidth = Math.max(0.5, stroke * 1.6);
        const a = outer * 0.55;
        ctx.beginPath();
        ctx.moveTo(x, y - a);
        ctx.lineTo(x, y + a);
        ctx.moveTo(x - a * 0.5, y + a * 0.45);
        ctx.lineTo(x, y + a);
        ctx.lineTo(x + a * 0.5, y + a * 0.45);
        ctx.stroke();
        return;
    }

    if (style === "spiral") {
        // Filled ring backdrop.
        ctx.fillStyle = TERMINUS_FILL;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = stroke;
        ctx.beginPath();
        ctx.arc(x, y, outer, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Inward spiral (Archimedean) — ~1.5 turns.
        ctx.strokeStyle = TERMINUS_INNER;
        ctx.lineWidth = Math.max(0.5, stroke * 1.4);
        ctx.beginPath();
        const turns = 1.6;
        const steps = 48;
        const rMax = outer * 0.7;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const angle = t * turns * Math.PI * 2;
            const r = rMax * (1 - t);
            const px = x + Math.cos(angle) * r;
            const py = y + Math.sin(angle) * r;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.stroke();
        return;
    }

    if (style === "tombstone") {
        // Rounded-top gravestone silhouette with a small cross etched in.
        const w = outer * 1.5;
        const h = outer * 1.8;
        const left = x - w / 2;
        const top = y - h * 0.5;
        const radius = w / 2;
        ctx.fillStyle = TERMINUS_FILL;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = stroke;
        ctx.beginPath();
        ctx.moveTo(left, y + h * 0.5);
        ctx.lineTo(left, top + radius);
        ctx.arc(x, top + radius, radius, Math.PI, 0, false);
        ctx.lineTo(left + w, y + h * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Cross etched on the stone.
        ctx.strokeStyle = TERMINUS_INNER;
        ctx.lineWidth = Math.max(0.5, stroke * 1.4);
        const armV = h * 0.35;
        const armH = w * 0.28;
        ctx.beginPath();
        ctx.moveTo(x, y - armV * 0.4);
        ctx.lineTo(x, y + armV * 0.6);
        ctx.moveTo(x - armH, y);
        ctx.lineTo(x + armH, y);
        ctx.stroke();
        return;
    }

    if (style === "cross") {
        // Filled disc + bold gothic cross on top. Reads at very small sizes.
        ctx.fillStyle = TERMINUS_FILL;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = stroke;
        ctx.beginPath();
        ctx.arc(x, y, outer, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        const armV = outer * 0.75;
        const armH = outer * 0.55;
        const thick = outer * 0.22;
        ctx.fillStyle = TERMINUS_INNER;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = Math.max(0.3, stroke * 0.8);
        // Vertical bar
        ctx.beginPath();
        ctx.rect(x - thick / 2, y - armV, thick, armV * 1.7);
        ctx.fill();
        ctx.stroke();
        // Horizontal bar (above center for traditional grave-cross look)
        ctx.beginPath();
        ctx.rect(x - armH, y - armV * 0.35, armH * 2, thick);
        ctx.fill();
        ctx.stroke();
        return;
    }

    if (style === "rift") {
        // Vertical "tear in the world" — jagged dark crack on a red badge.
        // Conveys the death-rift / return-portal idea without skull imagery.
        ctx.fillStyle = TERMINUS_FILL;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = stroke;
        ctx.beginPath();
        ctx.arc(x, y, outer, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Jagged crack: alternating offsets down a vertical axis.
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = Math.max(0.6, stroke * 1.8);
        ctx.lineJoin = "miter";
        const h = outer * 0.85;
        const jag = outer * 0.18;
        ctx.beginPath();
        ctx.moveTo(x, y - h);
        ctx.lineTo(x + jag, y - h * 0.5);
        ctx.lineTo(x - jag * 0.7, y - h * 0.1);
        ctx.lineTo(x + jag * 0.6, y + h * 0.3);
        ctx.lineTo(x - jag * 0.5, y + h * 0.65);
        ctx.lineTo(x, y + h);
        ctx.stroke();
        // Highlight strand to give it depth.
        ctx.strokeStyle = TERMINUS_INNER;
        ctx.lineWidth = Math.max(0.3, stroke * 0.8);
        ctx.beginPath();
        ctx.moveTo(x + jag * 0.15, y - h * 0.7);
        ctx.lineTo(x - jag * 0.2, y - h * 0.2);
        ctx.lineTo(x + jag * 0.25, y + h * 0.2);
        ctx.lineTo(x - jag * 0.1, y + h * 0.75);
        ctx.stroke();
        return;
    }
}

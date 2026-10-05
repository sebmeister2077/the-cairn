import {
  drawTraderMarker,
  drawTLEndpoint,
  drawTerminusMarker,
  drawRapidsMarker,
} from "@/lib/markerStyles";
import { rgbaFromHex } from "@/lib/color";
import type { RouteOverlay } from "@/components/tops-map-viewer/MapViewer";

export interface OverlayDrawArgs {
  segments: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    /** Canonical TL id (`${x1},${z1},${x2},${z2}`) used by the radius
     *  cull's `alwaysShowTLIds` lookup. */
    tlId: string;
    kind?: "default" | "user";
    /** Optional per-segment color override (hex like `#a855f7`). When set,
     *  the segment skips the default purple/blue pass and is drawn with this
     *  color (and a derived translucent glow) instead. */
    color?: string;
  }>;
  points: Array<{
    x: number;
    y: number;
    label?: string;
    kind?: string;
    color?: string;
    claimed?: boolean;
  }>;
  route: {
    tlSegs: Array<{ x1: number; y1: number; x2: number; y2: number }>;
    walkLegs: Array<{
      key?: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      elkState?: RouteOverlay["walkLegs"][number]["elkState"];
      ignored?: boolean;
    }>;
    from: { x: number; y: number } | null;
    to: { x: number; y: number } | null;
    tlIdSet: Set<string>;
    focusedWalkLegKey?: string | null;
  } | null;
  hoveredSegmentIndex: number | null;
  highlightedSegmentIndices: Set<number>;
  routeTLBaseSkipIndices: Set<number>;
  tlStyle: string;
  traderStyle: string;
  terminusStyle: string;
  rapidsStyle: string;
  /**
   * Optional cursor-radius cull. When non-null, segments whose `tlId`
   * is not in `alwaysShowTLIds` AND whose endpoints are both farther
   * than `radiusScreen` (screen px) from `(cursorX, cursorY)` are
   * skipped entirely (no line, no glow, no portal dots, no hover/
   * highlight outline).
   */
  radiusCull?: {
    cursorX: number;
    cursorY: number;
    radiusScreen: number;
    alwaysShowTLIds: ReadonlySet<string>;
  } | null;
}

/**
 * Draws every overlay layer onto the provided context using already-projected
 * screen-space coordinates. Mirrors the visual style of the Cairn-backed
 * {@link MapViewer}; sizes are quoted directly in screen px (no zoom
 * compensation needed since the canvas is screen-space).
 *
 * The marker helpers (`drawTLEndpoint`, `drawTraderMarker`,
 * `drawTerminusMarker`) expect an image-space zoom argument that they divide
 * radii by — they were written for the image-space canvas in MapViewer.
 * We pass `1` so radii are interpreted in CSS px directly, which is exactly
 * what we want for a screen-space canvas.
 */
export function drawOverlaysScreenSpace(ctx: CanvasRenderingContext2D, args: OverlayDrawArgs): void {
  const {
    segments,
    points,
    route,
    hoveredSegmentIndex,
    highlightedSegmentIndices,
    routeTLBaseSkipIndices,
    tlStyle,
    traderStyle,
    terminusStyle,
    rapidsStyle,
    radiusCull,
  } = args;

  if (segments.length === 0 && points.length === 0 && !route) return;

  // Pre-compute the cursor-radius cull set: segments whose `tlId` is not
  // in `alwaysShowTLIds` and whose endpoints are both outside the radius
  // get skipped in every pass below (line/glow/hover/highlight/dots).
  let cullSkipIndices: Set<number> | null = null;
  if (radiusCull && segments.length > 0) {
    cullSkipIndices = new Set<number>();
    const { cursorX, cursorY, radiusScreen, alwaysShowTLIds } = radiusCull;
    const radSq = radiusScreen * radiusScreen;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (alwaysShowTLIds.has(s.tlId)) continue;
      const dx1 = s.x1 - cursorX;
      const dy1 = s.y1 - cursorY;
      if (dx1 * dx1 + dy1 * dy1 <= radSq) continue;
      const dx2 = s.x2 - cursorX;
      const dy2 = s.y2 - cursorY;
      if (dx2 * dx2 + dy2 * dy2 <= radSq) continue;
      cullSkipIndices.add(i);
    }
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const baseLineColor = "rgba(139, 92, 246, 0.95)";
  const hoverLineColor = "rgba(243, 232, 255, 1)";
  const glowColor = "rgba(76, 29, 149, 0.55)";
  const portalOuter = "rgba(168, 85, 247, 0.95)";
  const userLineColor = "rgba(37, 99, 235, 0.95)";
  const userGlowColor = "rgba(30, 58, 138, 0.55)";
  const userPortalOuter = "rgba(59, 130, 246, 0.95)";

  const baseWidth = 2.3;
  const glowWidth = baseWidth * 2.4;

  // ── Translocator segments ────────────────────────────────────────────────
  if (segments.length > 0) {
    const defaultSegs: typeof segments = [];
    const userSegs: typeof segments = [];
    /** Per-color buckets for `color`-overridden segments. */
    const colorBuckets = new Map<string, typeof segments>();
    for (let i = 0; i < segments.length; i++) {
      if (routeTLBaseSkipIndices.has(i)) continue;
      if (cullSkipIndices?.has(i)) continue;
      const s = segments[i];
      if (s.color) {
        let bucket = colorBuckets.get(s.color);
        if (!bucket) {
          bucket = [];
          colorBuckets.set(s.color, bucket);
        }
        bucket.push(s);
      } else if (s.kind === "user") userSegs.push(s);
      else defaultSegs.push(s);
    }
    const drawPass = (segs: typeof segments, line: string, glow: string) => {
      if (segs.length === 0) return;
      ctx.strokeStyle = glow;
      ctx.lineWidth = glowWidth;
      ctx.beginPath();
      for (const s of segs) {
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
      }
      ctx.stroke();
      ctx.strokeStyle = line;
      ctx.lineWidth = baseWidth;
      ctx.beginPath();
      for (const s of segs) {
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
      }
      ctx.stroke();
    };
    drawPass(defaultSegs, baseLineColor, glowColor);
    drawPass(userSegs, userLineColor, userGlowColor);
    for (const [hex, segs] of colorBuckets) {
      drawPass(segs, rgbaFromHex(hex, 0.95), rgbaFromHex(hex, 0.45));
    }

    if (
      hoveredSegmentIndex !== null &&
      segments[hoveredSegmentIndex] &&
      !cullSkipIndices?.has(hoveredSegmentIndex)
    ) {
      const s = segments[hoveredSegmentIndex];
      ctx.strokeStyle = hoverLineColor;
      ctx.lineWidth = baseWidth * 1.6;
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    }
    if (highlightedSegmentIndices.size > 0) {
      ctx.strokeStyle = hoverLineColor;
      ctx.lineWidth = baseWidth * 1.6;
      ctx.beginPath();
      for (const idx of highlightedSegmentIndices) {
        if (idx === hoveredSegmentIndex) continue;
        if (cullSkipIndices?.has(idx)) continue;
        const s = segments[idx];
        if (!s) continue;
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
      }
      ctx.stroke();
    }

    // Portal-dot endpoints. `drawTLEndpoint` was authored for the
    // image-space MapViewer canvas and divides its radius by the supplied
    // `zoom` to keep dots a constant on-screen size; we pass 1 so radii are
    // already in CSS pixels.
    for (const s of defaultSegs) {
      drawTLEndpoint(ctx, s.x1, s.y1, 1, tlStyle as never, portalOuter);
      drawTLEndpoint(ctx, s.x2, s.y2, 1, tlStyle as never, portalOuter);
    }
    for (const s of userSegs) {
      drawTLEndpoint(ctx, s.x1, s.y1, 1, tlStyle as never, userPortalOuter);
      drawTLEndpoint(ctx, s.x2, s.y2, 1, tlStyle as never, userPortalOuter);
    }
    for (const [hex, segs] of colorBuckets) {
      const dot = rgbaFromHex(hex, 0.95);
      for (const s of segs) {
        drawTLEndpoint(ctx, s.x1, s.y1, 1, tlStyle as never, dot);
        drawTLEndpoint(ctx, s.x2, s.y2, 1, tlStyle as never, dot);
      }
    }
  }

  // ── Point markers ────────────────────────────────────────────────────────
  if (points.length > 0) {
    const pointOuter = 3.6;
    const pointInner = pointOuter * 0.48;

    ctx.fillStyle = "rgba(34, 211, 238, 0.92)";
    for (const p of points) {
      if (
        p.kind === "Server" ||
        p.kind === "Trader" ||
        p.kind === "Home" ||
        p.kind === "Terminus" ||
        p.kind === "BrokenTL" ||
        p.kind === "Rapids"
      )
        continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, pointOuter, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(236, 254, 255, 0.98)";
    for (const p of points) {
      if (
        p.kind === "Server" ||
        p.kind === "Trader" ||
        p.kind === "Home" ||
        p.kind === "Terminus" ||
        p.kind === "BrokenTL" ||
        p.kind === "Rapids"
      )
        continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, pointInner, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const p of points) {
      if (p.kind !== "Trader") continue;
      drawTraderMarker(
        ctx,
        p.x,
        p.y,
        1,
        traderStyle as never,
        p.color ?? "rgba(34, 211, 238, 0.92)",
      );
    }

    // Server (spawn) star
    const starOuter = 7.2;
    const starInner = starOuter * 0.45;
    const drawStar = (cx: number, cy: number) => {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? starOuter : starInner;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };
    ctx.lineWidth = 1.1;
    for (const p of points) {
      if (p.kind !== "Server") continue;
      drawStar(p.x, p.y);
      ctx.fillStyle = "rgba(250, 204, 21, 0.95)";
      ctx.fill();
      ctx.strokeStyle = "rgba(15, 23, 42, 0.85)";
      ctx.stroke();
    }

    // Home glyph
    const homeSize = 3.6;
    ctx.lineWidth = 0.55;
    for (const p of points) {
      if (p.kind !== "Home") continue;
      const half = homeSize;
      const bodyTopY = p.y - half * 0.15;
      const bodyBottomY = p.y + half;
      const leftX = p.x - half;
      const rightX = p.x + half;
      ctx.beginPath();
      ctx.moveTo(leftX, bodyBottomY);
      ctx.lineTo(leftX, bodyTopY);
      ctx.lineTo(p.x, p.y - half);
      ctx.lineTo(rightX, bodyTopY);
      ctx.lineTo(rightX, bodyBottomY);
      ctx.closePath();
      ctx.fillStyle = p.color ?? "rgba(245, 158, 11, 0.95)";
      ctx.fill();
      ctx.strokeStyle = "rgba(15, 23, 42, 0.9)";
      ctx.stroke();
      const doorW = homeSize * 0.32;
      const doorH = homeSize * 0.55;
      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      ctx.fillRect(p.x - doorW / 2, p.y + homeSize - doorH, doorW, doorH);
    }

    for (const p of points) {
      if (p.kind !== "Terminus") continue;
      drawTerminusMarker(ctx, p.x, p.y, 1, terminusStyle as never);
    }

    // Broken-translocator markers (recorded session exports) — bold filled
    // red disc with a dark outline and a white "broken" X, unmistakably
    // distinct from the cyan landmark dots.
    const tlOuter = 6.6;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const p of points) {
      if (p.kind !== "BrokenTL") continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, tlOuter, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(220, 38, 38, 0.95)"; // red-600
      ctx.fill();
      ctx.strokeStyle = "rgba(15, 23, 42, 0.9)";
      ctx.lineWidth = 1.1;
      ctx.stroke();
      const d = tlOuter * 0.5;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.98)";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(p.x - d, p.y - d);
      ctx.lineTo(p.x + d, p.y + d);
      ctx.moveTo(p.x + d, p.y - d);
      ctx.lineTo(p.x - d, p.y + d);
      ctx.stroke();
    }

    // Rapids source markers — user-selected glyph, coloured + haloed by
    // claimed state (see useRapidsOverlay + drawRapidsMarker).
    for (const p of points) {
      if (p.kind !== "Rapids") continue;
      drawRapidsMarker(
        ctx,
        p.x,
        p.y,
        1,
        rapidsStyle as never,
        p.color ?? "rgba(45, 212, 191, 0.95)",
        p.claimed,
      );
    }
  }

  // ── Route overlay ────────────────────────────────────────────────────────
  if (route) {
    if (route.walkLegs.length > 0) {
      const dashUnit = 8;
      const walkW = 2.0;
      ctx.setLineDash([]);
      ctx.strokeStyle = "rgba(15, 23, 42, 0.7)";
      ctx.lineWidth = walkW * 2.2;
      ctx.beginPath();
      for (const leg of route.walkLegs) {
        ctx.moveTo(leg.x1, leg.y1);
        ctx.lineTo(leg.x2, leg.y2);
      }
      ctx.stroke();

      // Per-state colour table — mirrors MapViewer so a confirmed /
      // pending walk reads the same in both viewers.
      const colourFor = (state: RouteOverlay["walkLegs"][number]["elkState"]): string => {
        switch (state) {
          case "confirmed":
          case "confirmed-by-me":
            return "rgba(56, 189, 248, 0.98)"; // sky-400
          case "pending-attest":
            return "rgba(250, 204, 21, 0.98)"; // amber-400
          case "pending-unattest":
            return "rgba(248, 113, 113, 0.98)"; // red-400
          default:
            return "rgba(226, 232, 240, 0.98)"; // slate-200
        }
      };
      const groups = new Map<string, { colour: string; legs: typeof route.walkLegs }>();
      for (const leg of route.walkLegs) {
        if (leg.ignored) continue; // ignored legs get the red/white pass below
        const colour = colourFor(leg.elkState);
        let bucket = groups.get(colour);
        if (!bucket) {
          bucket = { colour, legs: [] };
          groups.set(colour, bucket);
        }
        bucket.legs.push(leg);
      }
      ctx.setLineDash([dashUnit, dashUnit * 0.75]);
      ctx.lineWidth = walkW;
      for (const { colour, legs } of groups.values()) {
        ctx.strokeStyle = colour;
        ctx.beginPath();
        for (const leg of legs) {
          ctx.moveTo(leg.x1, leg.y1);
          ctx.lineTo(leg.x2, leg.y2);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // Ignored legs: a bold red barber-stripe so excluded connections
      // read unmistakably as "red / not being submitted".
      const ignoredLegs = route.walkLegs.filter((l) => l.ignored);
      if (ignoredLegs.length > 0) {
        ctx.save();
        ctx.lineCap = "round";
        ctx.setLineDash([]);
        ctx.strokeStyle = "rgba(220, 38, 38, 0.98)"; // red-600 base
        ctx.lineWidth = walkW * 1.6;
        ctx.beginPath();
        for (const leg of ignoredLegs) {
          ctx.moveTo(leg.x1, leg.y1);
          ctx.lineTo(leg.x2, leg.y2);
        }
        ctx.stroke();
        ctx.setLineDash([dashUnit * 0.9, dashUnit * 0.9]);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
        ctx.lineWidth = walkW * 1.6;
        ctx.beginPath();
        for (const leg of ignoredLegs) {
          ctx.moveTo(leg.x1, leg.y1);
          ctx.lineTo(leg.x2, leg.y2);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Pulsing focused-leg highlight — mirrors the highlight in
      // MapViewer.tsx so a user-selected edge stands out in both viewers.
      if (route.focusedWalkLegKey) {
        const focused = route.walkLegs.find((l) => l.key === route.focusedWalkLegKey);
        if (focused) {
          const phase = (Math.sin((performance.now() / 1000) * 1.2 * Math.PI * 2) + 1) / 2;
          ctx.save();
          ctx.lineCap = "round";
          ctx.strokeStyle = `rgba(250, 204, 21, ${(0.35 + phase * 0.45).toFixed(3)})`;
          ctx.lineWidth = walkW * (3.8 + phase * 2.6);
          ctx.beginPath();
          ctx.moveTo(focused.x1, focused.y1);
          ctx.lineTo(focused.x2, focused.y2);
          ctx.stroke();
          ctx.strokeStyle = "rgba(254, 240, 138, 0.95)";
          ctx.lineWidth = walkW * 1.4;
          ctx.beginPath();
          ctx.moveTo(focused.x1, focused.y1);
          ctx.lineTo(focused.x2, focused.y2);
          ctx.stroke();
          const ringR = 4.5 + phase * 3.5;
          ctx.strokeStyle = `rgba(250, 204, 21, ${(0.55 + phase * 0.4).toFixed(3)})`;
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.arc(focused.x1, focused.y1, ringR, 0, Math.PI * 2);
          ctx.moveTo(focused.x2 + ringR, focused.y2);
          ctx.arc(focused.x2, focused.y2, ringR, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }
    }
    if (route.tlSegs.length > 0) {
      const routeBase = 2.8;
      ctx.strokeStyle = "rgba(6, 78, 59, 0.6)";
      ctx.lineWidth = routeBase * 2.4;
      ctx.beginPath();
      for (const s of route.tlSegs) {
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
      }
      ctx.stroke();
      ctx.strokeStyle = "rgba(16, 185, 129, 0.98)";
      ctx.lineWidth = routeBase;
      ctx.beginPath();
      for (const s of route.tlSegs) {
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
      }
      ctx.stroke();
      const dotOuter = 3.4;
      const dotInner = dotOuter * 0.5;
      ctx.fillStyle = "rgba(16, 185, 129, 0.98)";
      for (const s of route.tlSegs) {
        ctx.beginPath();
        ctx.arc(s.x1, s.y1, dotOuter, 0, Math.PI * 2);
        ctx.arc(s.x2, s.y2, dotOuter, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "rgba(236, 253, 245, 0.98)";
      for (const s of route.tlSegs) {
        ctx.beginPath();
        ctx.arc(s.x1, s.y1, dotInner, 0, Math.PI * 2);
        ctx.arc(s.x2, s.y2, dotInner, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const pinRadius = 7.5;
    const drawPin = (cx: number, cy: number, fill: string, label: string) => {
      ctx.beginPath();
      ctx.arc(cx, cy - pinRadius, pinRadius, Math.PI * 0.2, Math.PI * 0.8, true);
      ctx.lineTo(cx, cy);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = "rgba(15, 23, 42, 0.9)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "rgba(248, 250, 252, 0.98)";
      ctx.font = `bold ${pinRadius * 1.1}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, cy - pinRadius);
    };
    if (route.from) drawPin(route.from.x, route.from.y, "rgba(34, 197, 94, 0.98)", "A");
    if (route.to) drawPin(route.to.x, route.to.y, "rgba(239, 68, 68, 0.98)", "B");
  }
}

/**
 * Draws labels for `overlayPoints` directly above their dots. Mirrors the
 * styling of MapViewer's labels canvas — keeps font and badge in screen px
 * so labels stay readable at every zoom.
 */
export function drawPointLabels(
  ctx: CanvasRenderingContext2D,
  points: Array<{ x: number; y: number; label?: string; kind?: string }>,
  w: number,
  h: number,
): void {
  const FONT_SIZE = 11;
  const PAD_X = 4;
  const PAD_Y = 2;
  const DOT_RADIUS = 4;
  ctx.font = `600 ${FONT_SIZE}px sans-serif`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  for (const p of points) {
    const raw = (p.label ?? "").replace(/\s+/g, " ").trim();
    if (!raw) continue;
    if (p.kind === "Home" || p.kind === "Terminus") continue;
    const sx = p.x;
    const sy = p.y;
    if (sx < -200 || sx > w + 200 || sy < -200 || sy > h + 200) continue;
    const isServer = p.kind === "Server";
    const text = raw.length > 30 ? `${raw.slice(0, 29)}\u2026` : raw;
    const textW = ctx.measureText(text).width;
    const textH = FONT_SIZE;
    const dotRadius = isServer ? DOT_RADIUS + 4 : DOT_RADIUS;
    const tx = sx + dotRadius + 3;
    const ty = sy - dotRadius - PAD_Y - textH;
    ctx.fillStyle = isServer ? "rgba(120, 53, 15, 0.88)" : "rgba(15, 23, 42, 0.80)";
    ctx.fillRect(tx - PAD_X, ty - PAD_Y, textW + PAD_X * 2, textH + PAD_Y * 2);
    ctx.fillStyle = isServer ? "rgba(254, 240, 138, 1)" : "rgba(236, 254, 255, 0.98)";
    ctx.fillText(text, tx, ty);
  }
}

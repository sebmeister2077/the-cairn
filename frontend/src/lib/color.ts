/**
 * Small colour helpers shared by the canvas-based map viewers.
 */

/**
 * Parse a `#rgb` / `#rrggbb` string into an `rgba(r, g, b, alpha)` literal.
 * Falls back to white on malformed input rather than throwing — bad colors
 * shouldn't blank the canvas.
 */
export function rgbaFromHex(hex: string, alpha: number): string {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  let r = 255;
  let g = 255;
  let b = 255;
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
  } else if (h.length === 6) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  }
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    r = g = b = 255;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

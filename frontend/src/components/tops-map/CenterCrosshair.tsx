/**
 * Subtle center crosshair drawn over the map viewer so it's easy to tell where
 * the exact middle of the viewport is (useful for "Go to coordinate" / "use
 * current center"). Purely decorative: it never intercepts pointer events.
 *
 * The white strokes carry a thin dark drop-shadow so the mark stays legible on
 * both bright and dark map tiles without being obtrusive. A small gap is left
 * in the middle so the precise center pixel is never covered.
 */
export function CenterCrosshair() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
    >
      <svg
        width="36"
        height="36"
        viewBox="0 0 36 36"
        className="opacity-55 drop-shadow-[0_0_1px_rgba(0,0,0,0.85)]"
      >
        <g stroke="white" strokeWidth="1.5" strokeLinecap="round">
          <line x1="18" y1="3" x2="18" y2="13" />
          <line x1="18" y1="23" x2="18" y2="33" />
          <line x1="3" y1="18" x2="13" y2="18" />
          <line x1="23" y1="18" x2="33" y2="18" />
        </g>
        <circle cx="18" cy="18" r="1" fill="white" />
      </svg>
    </div>
  );
}

// Tiny inline SVG sparkline for a numeric series — a purely visual shape cue for
// price movement in the Insights screener. No axes or labels; the accompanying
// trend percentage carries the exact figure and screen-reader text.

import { cn } from "@/lib/utils";

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
  /** Stroke colour; defaults to `currentColor` so it inherits the cell's text. */
  color?: string;
  strokeWidth?: number;
  /**
   * Optional value to draw a faint dashed horizontal reference line at (e.g. the
   * median), so it's easy to read whether the latest point sits above or below
   * the typical price. Clamped into the visible range.
   */
  baseline?: number;
  /**
   * Optional tooltip / accessible label. When set, the sparkline is exposed to
   * assistive tech as an image and shows a native hover tooltip instead of being
   * purely decorative.
   */
  title?: string;
}

export function Sparkline({
  data,
  width = 56,
  height = 18,
  className,
  color,
  strokeWidth = 1.25,
  baseline,
  title,
}: SparklineProps) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = strokeWidth; // keep the stroke from clipping at the top/bottom
  const usableH = height - pad * 2;
  const stepX = width / (data.length - 1);
  const yFor = (v: number) => pad + (1 - (v - min) / span) * usableH;
  const points = data.map((v, i) => `${(i * stepX).toFixed(1)},${yFor(v).toFixed(1)}`).join(" ");
  const baseY = baseline != null ? yFor(Math.min(max, Math.max(min, baseline))) : null;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("overflow-visible", className)}
      preserveAspectRatio="none"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {/* Transparent full-area rect so the native <title> tooltip triggers when
          hovering anywhere over the sparkline, not just the 1.5px line itself. */}
      {title && <rect x={0} y={0} width={width} height={height} fill="transparent" />}
      {baseY != null && (
        <line
          x1={0}
          y1={baseY}
          x2={width}
          y2={baseY}
          className="text-muted-foreground/70"
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="3 2"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <polyline
        points={points}
        fill="none"
        stroke={color ?? "currentColor"}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

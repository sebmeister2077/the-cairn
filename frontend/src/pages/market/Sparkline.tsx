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
}

export function Sparkline({
  data,
  width = 56,
  height = 18,
  className,
  color,
  strokeWidth = 1.25,
}: SparklineProps) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = strokeWidth; // keep the stroke from clipping at the top/bottom
  const usableH = height - pad * 2;
  const stepX = width / (data.length - 1);
  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = pad + (1 - (v - min) / span) * usableH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("overflow-visible", className)}
      preserveAspectRatio="none"
      aria-hidden
    >
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

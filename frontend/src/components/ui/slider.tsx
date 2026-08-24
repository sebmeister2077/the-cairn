/**
 * Slider — themed range input.
 *
 * A custom-styled wrapper around a native `<input type="range">`. The native
 * input is layered transparently on top of a painted track + thumb so we
 * keep full keyboard / screen-reader behaviour but get a themed look that
 * doesn't feel like a default OS widget.
 *
 * Optional `snapMarkers` render small tick marks at specific values along
 * the track (useful for presets like Fast / Balanced / High / Max).
 */

import * as React from "react";

import { cn } from "@/lib/utils";

export interface SliderSnapMarker {
  /** Value at which to render the tick. Must lie within [min, max]. */
  value: number;
  /** Optional label, exposed for callers that want to render their own chips. */
  label?: string;
}

export interface SliderProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "defaultValue" | "onChange"
> {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange: (value: number) => void;
  snapMarkers?: SliderSnapMarker[];
  /** Wrapper className (applied to the outer relative container). */
  className?: string;
  /** Adjust the value with the mouse wheel while hovering. Default on. */
  wheel?: boolean;
  /** Render a compact number field beside the track for keyboard entry. */
  showInput?: boolean;
}

/** Round `v` to the nearest `step` starting from `min`, clamped to [min,max]. */
function snapToStep(v: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, v));
  if (step <= 0) return clamped;
  const snapped = min + Math.round((clamped - min) / step) * step;
  // Kill float dust (e.g. 0.30000000000000004) using the step's decimal count.
  const decimals = (String(step).split(".")[1] ?? "").length;
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(decimals));
}

export const Slider = React.forwardRef<HTMLInputElement, SliderProps>(function Slider(
  {
    value,
    min = 0,
    max = 100,
    step = 1,
    onValueChange,
    snapMarkers,
    className,
    disabled,
    wheel = true,
    showInput = false,
    ...inputProps
  },
  ref,
) {
  const range = max - min;
  const pct = range > 0 ? ((value - min) / range) * 100 : 0;
  const trackRef = React.useRef<HTMLDivElement>(null);

  // Native (non-passive) wheel listener so we can preventDefault and keep the
  // map/page from scrolling while the cursor is over the slider.
  React.useEffect(() => {
    const node = trackRef.current;
    if (!node || !wheel || disabled) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.deltaY < 0 ? 1 : -1;
      const mult = e.shiftKey ? 10 : 1;
      onValueChange(snapToStep(value + dir * step * mult, min, max, step));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [wheel, disabled, value, step, min, max, onValueChange]);

  const track = (
    <div
      ref={trackRef}
      className={cn("relative h-6 select-none", showInput && "flex-1", className)}
    >
      {/* Track background */}
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-muted" />
      {/* Filled portion */}
      <div
        className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-primary transition-[width] duration-75"
        style={{ width: `${pct}%` }}
      />
      {/* Snap tick marks */}
      {snapMarkers?.map((m) => {
        const mPct = range > 0 ? ((m.value - min) / range) * 100 : 0;
        const passed = value >= m.value;
        return (
          <div
            key={`tick-${m.value}`}
            className={cn(
              "absolute top-1/2 -translate-y-1/2 w-px h-2.5 rounded-full pointer-events-none",
              passed ? "bg-primary/60" : "bg-muted-foreground/40",
            )}
            style={{ left: `${mPct}%` }}
          />
        );
      })}
      {/* Painted thumb (purely visual; the real thumb is the
          transparent native input above it) */}
      <div
        className={cn(
          "absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-4 rounded-full bg-background border-2 border-primary shadow-sm pointer-events-none transition-transform duration-75",
          disabled && "opacity-50",
        )}
        style={{ left: `${pct}%` }}
      />
      <input
        ref={ref}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(parseFloat(e.target.value))}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer focus-visible:outline-none peer disabled:cursor-not-allowed"
        {...inputProps}
      />
      {/* Focus ring drawn on the painted thumb when the native input is keyboard-focused */}
      <div
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-4 rounded-full pointer-events-none ring-2 ring-ring ring-offset-2 ring-offset-background opacity-0 peer-focus-visible:opacity-100 transition-opacity"
        style={{ left: `${pct}%` }}
      />
    </div>
  );

  if (!showInput) return track;

  return (
    <div className="flex items-center gap-2">
      {track}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const raw = parseFloat(e.target.value);
          if (Number.isNaN(raw)) return;
          onValueChange(snapToStep(raw, min, max, step));
        }}
        className="h-7 w-16 shrink-0 rounded-md border bg-background px-2 text-xs tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      />
    </div>
  );
});

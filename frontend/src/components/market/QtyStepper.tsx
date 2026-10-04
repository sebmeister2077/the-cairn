import { useEffect, useRef } from "react";
import { Minus, Plus } from "lucide-react";

/** Compact quantity stepper with visible −/+ buttons. Uses a text input with a
 * digit-only guard (not `type="number"`) so there are no native spinner arrows
 * and a partially-typed value isn't snapped to 0. Press-and-hold on either
 * button auto-repeats and accelerates the longer it is held. */
export function QtyStepper({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const num = Number.parseInt(value, 10);
  const current = Number.isFinite(num) ? num : 0;

  // Latest committed value, read inside the repeat loop to avoid stale closures.
  const currentRef = useRef(current);
  currentRef.current = current;

  const bump = (delta: number) => onChange(String(Math.max(0, currentRef.current + delta)));

  // Timers for press-and-hold auto-repeat.
  const holdTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopHold = () => {
    if (holdTimeout.current !== null) {
      clearTimeout(holdTimeout.current);
      holdTimeout.current = null;
    }
    if (holdInterval.current !== null) {
      clearInterval(holdInterval.current);
      holdInterval.current = null;
    }
  };

  const startHold = (delta: number) => {
    stopHold();
    bump(delta); // immediate step on press
    // Short delay before repeat kicks in, then accelerate from 150ms → 40ms.
    holdTimeout.current = setTimeout(() => {
      let intervalMs = 150;
      const tick = () => {
        bump(delta);
        const next = Math.max(40, intervalMs - 15);
        if (next !== intervalMs) {
          intervalMs = next;
          if (holdInterval.current !== null) clearInterval(holdInterval.current);
          holdInterval.current = setInterval(tick, intervalMs);
        }
      };
      holdInterval.current = setInterval(tick, intervalMs);
    }, 350);
  };

  // Clean up timers if the component unmounts mid-hold.
  useEffect(() => stopHold, []);

  const holdHandlers = (delta: number) => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return; // primary button only
      e.currentTarget.setPointerCapture?.(e.pointerId);
      startHold(delta);
    },
    onPointerUp: stopHold,
    onPointerLeave: stopHold,
    onPointerCancel: stopHold,
  });

  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-hidden rounded-lg border border-input">
      <button
        type="button"
        aria-label="Decrease quantity"
        disabled={current <= 0}
        {...holdHandlers(-1)}
        className="flex w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <Minus className="h-3.5 w-3.5" aria-hidden />
      </button>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        aria-label="Quantity"
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "" || /^\d+$/.test(raw)) onChange(raw);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            e.preventDefault();
            bump(1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            bump(-1);
          }
        }}
        className="w-10 border-x border-input bg-transparent text-center text-base tabular-nums outline-none focus-visible:bg-accent/30 md:text-sm dark:bg-input/30"
      />
      <button
        type="button"
        aria-label="Increase quantity"
        {...holdHandlers(1)}
        className="flex w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

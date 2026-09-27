// Reusable two-line x-axis tick for recharts: a primary label with a smaller
// secondary label beneath it (e.g. in-game date over its real-world date).
//
// Colors use Tailwind `fill-*` classes (applied via CSS) rather than
// `fill="hsl(var(--…))"` attributes, because browsers do not resolve `var()`
// inside SVG presentation attributes — that silently falls back to black and
// disappears in dark mode.

import { formatGameDate, formatListingDate } from "./VirtualTable";

export interface AxisTickProps {
  x?: number | string;
  y?: number | string;
  payload?: { value: number | string };
}

/** Build a two-line tick renderer from a primary and (optional) secondary
 * formatter. Returning `null` from `getSub` omits the second line. */
export function createDualLineTick(
  formatMain: (value: number | string) => string,
  getSub: (value: number | string) => string | null,
) {
  return function DualLineTick({ x = 0, y = 0, payload }: AxisTickProps) {
    const value = payload?.value ?? 0;
    const sub = getSub(value);
    return (
      <g transform={`translate(${Number(x)},${Number(y)})`}>
        <text x={0} y={0} dy={12} textAnchor="middle" fontSize={11} className="fill-foreground">
          {formatMain(value)}
        </text>
        {sub && (
          <text
            x={0}
            y={0}
            dy={25}
            textAnchor="middle"
            fontSize={9}
            className="fill-muted-foreground"
          >
            {sub}
          </text>
        )}
      </g>
    );
  };
}

/** Nearest-neighbour lookup from an in-game time (`t`) to the real-world date of
 * the closest recorded point — for the secondary axis line. Ticks fall at
 * arbitrary in-game times, not on exact recorded samples, so we snap. */
export function makeRealDateLookup(
  points: { t: number; observedUtc?: string | null }[],
): (t: number) => string | null {
  const pts = points
    .filter((d) => d.observedUtc)
    .map((d) => ({ t: d.t, iso: d.observedUtc as string }))
    .sort((a, b) => a.t - b.t);
  return (t: number) => {
    if (pts.length === 0) return null;
    let best = pts[0];
    let bestDiff = Math.abs(pts[0].t - t);
    for (let i = 1; i < pts.length; i++) {
      const diff = Math.abs(pts[i].t - t);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = pts[i];
      }
    }
    return best.iso;
  };
}

/** Convenience tick for the common case: primary line = in-game date, secondary
 * line = real-world date of the nearest recorded point. */
export function createGameDateTick(realDateAt: (t: number) => string | null) {
  return createDualLineTick(
    (v) => formatGameDate(Number(v)),
    (v) => {
      const iso = realDateAt(Number(v));
      return iso ? formatListingDate(iso) : null;
    },
  );
}

const MS_PER_DAY = 86_400_000;

/** Map an in-game total-hours value to a real-world date (ISO) using the fixed
 * in-game-hours-per-real-day cadence and a single `(gameHours, realMs)` anchor.
 * Returns a function that yields null when the anchor is unusable. Callers pass
 * the cadence so the constant stays defined in one place. */
export function makeGameHoursToRealIso(
  anchorGameHours: number | null | undefined,
  anchorRealMs: number | null | undefined,
  gameHoursPerRealDay: number,
): (gameHours: number) => string | null {
  if (
    anchorGameHours == null ||
    anchorRealMs == null ||
    !Number.isFinite(anchorGameHours) ||
    !Number.isFinite(anchorRealMs) ||
    !gameHoursPerRealDay
  ) {
    return () => null;
  }
  return (g: number) => {
    if (!Number.isFinite(g)) return null;
    const ms = anchorRealMs - ((anchorGameHours - g) / gameHoursPerRealDay) * MS_PER_DAY;
    return new Date(ms).toISOString();
  };
}

/** Two-line tick for charts whose x-axis is a formatted game-date `label`
 * string: shows the label, and beneath it the real-world date of the game-hours
 * that produced it (via `labelToGameHours` + `realDateForGameHours`). */
export function createLabelRealDateTick(
  labelToGameHours: Map<string, number>,
  realDateForGameHours: (gameHours: number) => string | null,
) {
  return createDualLineTick(
    (v) => String(v),
    (v) => {
      const g = labelToGameHours.get(String(v));
      if (g == null) return null;
      const iso = realDateForGameHours(g);
      return iso ? formatListingDate(iso) : null;
    },
  );
}

// Pattern + path generation for the tunnel-builder tool.
//
// All math is integer-block: positions are unit-cube voxels in
// Vintage Story world coords (+X east, +Y up, +Z south). Every block
// in a generated path is **face-adjacent** to its neighbour (exactly
// one of x/y/z differs by ±1) — the supercover-line invariant — so
// the result is diggable as a single connected tunnel.

import type { Block3 } from "./tunnel-share";

export type Axis = "x" | "y" | "z";

/** Marks a path block as a half-height slab instead of a full cube.
 *  `"top"` = top half of voxel is solid (slab on the upper half);
 *  `"bottom"` = bottom half of voxel is solid. Affects 3D rendering
 *  and is reported in stats; the underlying coordinate is unchanged. */
export type SlabKind = "top" | "bottom";

/** Path entry. Extends `Block3` so existing geometry helpers keep
 *  working unchanged; the optional `slab` is only set when the user
 *  enabled `useSlabs` and the block sits at a vertical step. */
export type PathBlock = Block3 & { slab?: SlabKind };

/** High-level tunnel shape. Only `"stepped"` consumes the per-axis
 *  step counts; only `"sequence"` consumes `sequence` + `padding`. */
export type TunnelMode =
    | "bresenham"
    | "vertical-first"
    | "vertical-last"
    | "stepped"
    | "even-stairs"
    | "snug-stairs"
    | "climb-stairs"
    | "stairs-climb"
    | "sequence";

export const TUNNEL_MODES: ReadonlyArray<TunnelMode> = [
    "bresenham",
    "even-stairs",
    "snug-stairs",
    "climb-stairs",
    "stairs-climb",
    "vertical-first",
    "vertical-last",
    "stepped",
    "sequence",
];

/** Single move letter understood by the sequence parser. F/B/L/R are
 *  relative to the **forward direction** — the dominant horizontal axis
 *  pointing from the start TL toward the end TL. R is 90° clockwise
 *  from forward (viewed from above). */
export type SequenceDir = "U" | "D" | "F" | "B" | "L" | "R";

export const SEQUENCE_DIRS: ReadonlyArray<SequenceDir> = ["U", "D", "F", "B", "L", "R"];

export interface SequenceToken {
    dir: SequenceDir;
    count: number;
}

export interface TunnelPattern {
    /** Lateral step count per cycle along X (E/W). Sign is preserved. */
    stepX: number;
    /** Lateral step count per cycle along Y (Up/Down). Sign is preserved. */
    stepY: number;
    /** Lateral step count per cycle along Z (N/S). Sign is preserved. */
    stepZ: number;
    /** Primary tunnelling axis — advances by 1 every cycle. The other
     *  two axes accumulate fractional offsets and shift when those
     *  cross 1. Only consumed when `mode === "stepped"`. */
    primaryAxis: Axis;
    /** Repeating move sequence (`"1U 2F 1R"`) for `mode === "sequence"`. */
    sequence: string;
    /** Number of straight forward blocks the path stays straight at
     *  each TL before/after the pattern kicks in. */
    padding: number;
    /** When true, each padding unit advances 1 X and 1 Z (two emitted
     *  blocks per unit) instead of `padding` blocks along the dominant
     *  horizontal axis. Falls back to straight when either dx or dz
     *  is zero. */
    paddingDiagonal: boolean;
    /** When true, post-process the generated path: any block that sits
     *  at a column-vertical step is marked as a half-slab so the 3D
     *  preview shows a smoother stair. Does not change the block
     *  positions, only their `slab` flag. */
    useSlabs: boolean;
}

export const DEFAULT_SEQUENCE = "1U 1F";
export const DEFAULT_PADDING = 2;
export const DEFAULT_PADDING_DIAGONAL = false;
export const DEFAULT_USE_SLABS = false;
const MAX_PADDING = 64;

const MAX_STEP = 64;

function gcd(a: number, b: number): number {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) [a, b] = [b, a % b];
    return a || 1;
}

function dominantAxis(dx: number, dy: number, dz: number): Axis {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const az = Math.abs(dz);
    if (ax >= ay && ax >= az) return "x";
    if (az >= ay) return "z";
    return "y";
}

/** Compute a clean integer pattern from `from`/`to`: pick the dominant
 *  axis as primary, reduce the three deltas by their gcd to lowest
 *  terms, and clamp each numerator to MAX_STEP so the manual sliders
 *  stay bounded. Sign reflects the from→to delta. */
export function autoFitPattern(from: Block3, to: Block3): TunnelPattern {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const base = {
        sequence: DEFAULT_SEQUENCE,
        padding: DEFAULT_PADDING,
        paddingDiagonal: DEFAULT_PADDING_DIAGONAL,
        useSlabs: DEFAULT_USE_SLABS,
    };
    if (dx === 0 && dy === 0 && dz === 0) {
        return { stepX: 0, stepY: 0, stepZ: 0, primaryAxis: "x", ...base };
    }
    const primary = dominantAxis(dx, dy, dz);
    const g = gcd(gcd(dx, dy), dz);
    let sx = dx / g;
    let sy = dy / g;
    let sz = dz / g;
    // Clamp numerators (preserve sign).
    const cap = (n: number) => Math.sign(n) * Math.min(Math.abs(n), MAX_STEP);
    sx = cap(sx);
    sy = cap(sy);
    sz = cap(sz);
    return {
        stepX: Math.round(sx),
        stepY: Math.round(sy),
        stepZ: Math.round(sz),
        primaryAxis: primary,
        ...base,
    };
}

/** Coerce any pattern to safe integer values within [-MAX_STEP, MAX_STEP]. */
export function clampPattern(p: TunnelPattern): TunnelPattern {
    const cap = (n: number) => {
        if (!Number.isFinite(n)) return 0;
        const r = Math.trunc(n);
        if (r > MAX_STEP) return MAX_STEP;
        if (r < -MAX_STEP) return -MAX_STEP;
        return r;
    };
    const padCap = (n: number) => {
        if (!Number.isFinite(n)) return 0;
        const r = Math.trunc(n);
        if (r > MAX_PADDING) return MAX_PADDING;
        if (r < 0) return 0;
        return r;
    };
    return {
        stepX: cap(p.stepX),
        stepY: cap(p.stepY),
        stepZ: cap(p.stepZ),
        primaryAxis: p.primaryAxis,
        sequence: typeof p.sequence === "string" ? p.sequence : DEFAULT_SEQUENCE,
        padding: padCap(p.padding ?? DEFAULT_PADDING),
        paddingDiagonal: Boolean(p.paddingDiagonal),
        useSlabs: Boolean(p.useSlabs),
    };
}

/** Generate the block-by-block path from `from` to `to` honoring the
 *  selected `mode`. Always includes both endpoints. Consecutive
 *  blocks are **face-adjacent** (exactly one of x/y/z differs by ±1),
 *  so the result is a single connected dig in voxel terms.
 *
 *  `pattern.padding` is applied uniformly to every mode: the path
 *  walks `padding` straight forward blocks out of each TL before/after
 *  the mode-specific shape kicks in. Forward = the dominant horizontal
 *  axis pointing from `from` toward `to`. */
export function generateTunnelPath(
    from: Block3,
    to: Block3,
    pattern: TunnelPattern,
    mode: TunnelMode = "bresenham",
    maxBlocks: number = 100_000,
): PathBlock[] {
    const path: PathBlock[] = [{ x: from.x, y: from.y, z: from.z }];
    if (from.x === to.x && from.y === to.y && from.z === to.z) {
        return path;
    }
    const c: Cursor = { x: from.x, y: from.y, z: from.z };

    // Forward axis = dominant horizontal toward `to`. If both
    // horizontals are zero we can't pad without overshooting.
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const fwdAxis: Axis = Math.abs(dx) >= Math.abs(dz) && dx !== 0 ? "x" : "z";
    const fwdDelta = to[fwdAxis] - from[fwdAxis];
    const fwdSign = Math.sign(fwdDelta);
    const xSign = Math.sign(dx);
    const zSign = Math.sign(dz);
    const padReq = Math.max(0, Math.min(MAX_PADDING, Math.trunc(pattern.padding ?? 0)));

    // Diagonal padding only kicks in when both horizontal axes have
    // delta — otherwise we'd silently double-pad along the one axis
    // that does have delta. Cap so start + end together don't overshoot
    // either axis and at least one walker block remains in between.
    const useDiagonal = Boolean(pattern.paddingDiagonal) && xSign !== 0 && zSign !== 0;
    let padding: number;
    if (useDiagonal) {
        const cap = Math.max(0, Math.floor((Math.min(Math.abs(dx), Math.abs(dz)) - 1) / 2));
        padding = Math.min(padReq, cap);
    } else {
        padding =
            fwdSign === 0
                ? 0
                : Math.min(padReq, Math.max(0, Math.floor((Math.abs(fwdDelta) - 1) / 2)));
    }

    // Start padding.
    if (useDiagonal) {
        for (let i = 0; i < padding; i++) {
            c.x += xSign;
            if (!emit(path, c, maxBlocks)) return path;
            c.z += zSign;
            if (!emit(path, c, maxBlocks)) return path;
        }
    } else {
        for (let i = 0; i < padding; i++) {
            c[fwdAxis] += fwdSign;
            if (!emit(path, c, maxBlocks)) return path;
        }
    }

    // Inner target = `to` shifted back so the walker stops short and
    // the tail padding lands on `to`. With diagonal padding we shift
    // both horizontal axes; otherwise only the forward axis.
    const innerTo: Block3 = { x: to.x, y: to.y, z: to.z };
    if (useDiagonal) {
        innerTo.x -= padding * xSign;
        innerTo.z -= padding * zSign;
    } else if (fwdAxis === "x") {
        innerTo.x -= padding * fwdSign;
    } else {
        innerTo.z -= padding * fwdSign;
    }

    // Slab pre-shift. With slabs on, each Y step in the walker output
    // becomes a slab+full pair consuming 2 forward blocks instead of
    // 1. To keep the final path landing on `to`, pull the walker's
    // target back along the forward axis by |dy_inner|; the post-pass
    // adds those forward blocks back. Only enabled when there's enough
    // forward room (>= 2×|dy|) so the walker still has space for the
    // climb portion after the pre-shift.
    const innerDy = innerTo.y - c.y;
    const innerFwdSpace = Math.abs(innerTo[fwdAxis] - c[fwdAxis]);
    const slabShift =
        pattern.useSlabs &&
            fwdSign !== 0 &&
            innerDy !== 0 &&
            innerFwdSpace >= 2 * Math.abs(innerDy)
            ? Math.abs(innerDy)
            : 0;
    const walkerTarget: Block3 = { x: innerTo.x, y: innerTo.y, z: innerTo.z };
    if (slabShift > 0) {
        if (fwdAxis === "x") walkerTarget.x -= slabShift * fwdSign;
        else walkerTarget.z -= slabShift * fwdSign;
    }

    const walkerStartIdx = path.length;

    switch (mode) {
        case "vertical-first":
            walkClimb45First(c, walkerTarget, path, maxBlocks);
            break;
        case "vertical-last":
            walkClimb45Last(c, walkerTarget, path, maxBlocks);
            break;
        case "stepped":
            walkStepped(c, walkerTarget, pattern, path, maxBlocks);
            break;
        case "even-stairs":
            walkSnappedStairs(c, walkerTarget, 8, path, maxBlocks);
            break;
        case "snug-stairs":
            walkSnappedStairs(c, walkerTarget, 32, path, maxBlocks);
            break;
        case "climb-stairs":
            walkClimbThenStairs(c, walkerTarget, 32, path, maxBlocks);
            break;
        case "stairs-climb":
            walkStairsThenClimb(c, walkerTarget, 32, path, maxBlocks);
            break;
        case "sequence":
            walkSequence(c, walkerTarget, pattern.sequence, path, maxBlocks);
            break;
        case "bresenham":
        default:
            walkBresenhamAuto(c, walkerTarget, path, maxBlocks);
            break;
    }

    if (slabShift > 0 && path.length > walkerStartIdx) {
        applySlabsToWalkerSegment(path, walkerStartIdx, fwdAxis, fwdSign);
        // Cursor must follow the post-shift end of the walker output
        // so end padding starts from the correct (shifted) position.
        const last = path[path.length - 1];
        c.x = last.x;
        c.y = last.y;
        c.z = last.z;
    }

    // End padding: land on `to`. Defensive: only step while we're
    // still short of the target so an unexpectedly-long walker can't
    // push us past. Diagonal mode emits alternating X/Z; straight mode
    // emits along the forward axis.
    if (useDiagonal) {
        while (c.x !== to.x || c.z !== to.z) {
            if (c.x !== to.x) {
                c.x += xSign;
                if (!emit(path, c, maxBlocks)) return path;
            }
            if (c.z !== to.z) {
                c.z += zSign;
                if (!emit(path, c, maxBlocks)) return path;
            }
        }
    } else {
        while (c[fwdAxis] !== to[fwdAxis]) {
            c[fwdAxis] += fwdSign;
            if (!emit(path, c, maxBlocks)) return path;
        }
    }

    return path;
}

/** Replace the walker portion of `path` (from `startIdx` onward) so
 *  every column-vertical step becomes a half-step using a bottom slab.
 *
 *  For each pair `(prev, cur)` with `cur.y !== prev.y` and matching
 *  x/z, the destination block is moved one block forward and marked
 *  as a bottom slab placed at the *higher* of the two y values. All
 *  subsequent walker blocks shift forward by the same amount. Net
 *  effect: 1 Y step now consumes 2 forward blocks (slab + full) and
 *  the player traverses it as a smooth half-block climb instead of a
 *  hard 1-block stair. Caller pre-shifts the walker's target so the
 *  final path still ends where it should.
 *
 *  The slab is always `"bottom"` (lower half solid → walking surface
 *  at y + 0.5). For ascents, the slab sits at `cur.y` and bridges
 *  full(prev.y) → slab(cur.y) → full(cur.y). For descents, the slab
 *  sits at `prev.y` and bridges full(prev.y) → slab(prev.y) → full(cur.y). */
function applySlabsToWalkerSegment(
    path: PathBlock[],
    startIdx: number,
    fwdAxis: Axis,
    fwdSign: number,
): void {
    if (startIdx >= path.length) return;
    if (startIdx < 1) return; // need a previous block to detect Y steps
    const original = path.slice(startIdx);
    path.length = startIdx;

    let prev: PathBlock = path[startIdx - 1];
    let offset = 0;
    for (const cur of original) {
        const isYStep = cur.y !== prev.y && cur.x === prev.x && cur.z === prev.z;
        if (isYStep) {
            offset += 1;
            const slabBlock: PathBlock = {
                x: cur.x + (fwdAxis === "x" ? offset * fwdSign : 0),
                y: Math.max(prev.y, cur.y),
                z: cur.z + (fwdAxis === "z" ? offset * fwdSign : 0),
                slab: "bottom",
            };
            path.push(slabBlock);
        } else {
            path.push({
                x: cur.x + (fwdAxis === "x" ? offset * fwdSign : 0),
                y: cur.y,
                z: cur.z + (fwdAxis === "z" ? offset * fwdSign : 0),
            });
        }
        prev = cur;
    }
}

interface Cursor {
    x: number;
    y: number;
    z: number;
}

function emit(path: Block3[], c: Cursor, max: number): boolean {
    if (path.length >= max) return false;
    path.push({ x: c.x, y: c.y, z: c.z });
    return true;
}

/** Walk one axis ±1 per step until cursor matches target, emitting
 *  every intermediate block. */
function walkAxis(c: Cursor, axis: Axis, target: number, path: Block3[], max: number): boolean {
    const sgn = Math.sign(target - c[axis]);
    while (c[axis] !== target) {
        c[axis] += sgn;
        if (!emit(path, c, max)) return false;
    }
    return true;
}

/** Core supercover loop: advance `primary` by 1 each iteration; for
 *  each lateral axis, accumulate `rates[axis]` per primary step and
 *  emit a single ±1 lateral move when the accumulator crosses 1.
 *  Every emission is a single-axis ±1 change → face-adjacent. */
function walkBresenhamCore(
    c: Cursor,
    to: Block3,
    primary: Axis,
    rates: { x: number; y: number; z: number },
    path: Block3[],
    max: number,
): boolean {
    const sgn: Record<Axis, number> = {
        x: Math.sign(to.x - c.x),
        y: Math.sign(to.y - c.y),
        z: Math.sign(to.z - c.z),
    };
    const acc: Record<Axis, number> = { x: 0, y: 0, z: 0 };

    while (c[primary] !== to[primary]) {
        c[primary] += sgn[primary];
        if (!emit(path, c, max)) return false;

        for (const a of ["x", "y", "z"] as Axis[]) {
            if (a === primary) continue;
            if (c[a] === to[a]) continue;
            acc[a] += rates[a];
            while (acc[a] >= 1 && c[a] !== to[a]) {
                c[a] += sgn[a];
                if (!emit(path, c, max)) return false;
                acc[a] -= 1;
            }
        }
    }
    // Drain any laterals the rate didn't carry all the way.
    for (const a of ["x", "y", "z"] as Axis[]) {
        if (a === primary) continue;
        if (!walkAxis(c, a, to[a], path, max)) return false;
    }
    return true;
}

/** 2D supercover line in the X/Z plane at the cursor's current Y. */
function walkBresenhamHorizontal(c: Cursor, to: Block3, path: Block3[], max: number): boolean {
    const dx = Math.abs(to.x - c.x);
    const dz = Math.abs(to.z - c.z);
    if (dx === 0 && dz === 0) return true;
    const primary: Axis = dx >= dz ? "x" : "z";
    const primaryD = primary === "x" ? dx : dz;
    const rates: Record<Axis, number> = {
        x: primary === "x" ? 0 : dx / Math.max(1, primaryD),
        y: 0,
        z: primary === "z" ? 0 : dz / Math.max(1, primaryD),
    };
    // Pin the target Y to the cursor's so the core loop never moves Y.
    return walkBresenhamCore(c, { x: to.x, y: c.y, z: to.z }, primary, rates, path, max);
}

/** Auto 3D supercover line — primary = dominant axis; lateral rates
 *  derived from the absolute deltas. */
function walkBresenhamAuto(c: Cursor, to: Block3, path: Block3[], max: number): boolean {
    const dx = Math.abs(to.x - c.x);
    const dy = Math.abs(to.y - c.y);
    const dz = Math.abs(to.z - c.z);
    if (dx === 0 && dy === 0 && dz === 0) return true;
    const primary: Axis = dx >= dy && dx >= dz ? "x" : dz >= dy ? "z" : "y";
    const primaryD = primary === "x" ? dx : primary === "y" ? dy : dz;
    const rates: Record<Axis, number> = {
        x: primary === "x" ? 0 : dx / Math.max(1, primaryD),
        y: primary === "y" ? 0 : dy / Math.max(1, primaryD),
        z: primary === "z" ? 0 : dz / Math.max(1, primaryD),
    };
    return walkBresenhamCore(c, to, primary, rates, path, max);
}

/** User-tunable stepped pattern. Falls back to the dominant axis if
 *  the user picked a primary with zero delta, so the path always
 *  reaches the target. */
function walkStepped(
    c: Cursor,
    to: Block3,
    pattern: TunnelPattern,
    path: Block3[],
    max: number,
): boolean {
    let primary = pattern.primaryAxis;
    if (c[primary] === to[primary]) {
        const fallback = (["x", "y", "z"] as Axis[]).find((a) => c[a] !== to[a]);
        if (fallback) primary = fallback;
        else return true;
    }
    const px = Math.abs(pattern.stepX);
    const py = Math.abs(pattern.stepY);
    const pz = Math.abs(pattern.stepZ);
    const denom = Math.max(1, primary === "x" ? px : primary === "y" ? py : pz);
    const rates: Record<Axis, number> = {
        x: primary === "x" ? 0 : px / denom,
        y: primary === "y" ? 0 : py / denom,
        z: primary === "z" ? 0 : pz / denom,
    };
    return walkBresenhamCore(c, to, primary, rates, path, max);
}

// ---------------------------------------------------------------------------
// Snapped staircase modes — auto-pick a clean small-integer ratio so the
// resulting path is one repeating cycle (with a small drain at the end)
// instead of the irregular multi-phase decomposition Bresenham produces
// on uneven deltas. The walker reuses `walkBresenhamCore`; only the rates
// differ.
// ---------------------------------------------------------------------------

/** Best p/q approximation of `target` (real number) with `q ≤ maxDenom`,
 *  minimising |p/q − target|. Sign of `target` is preserved on `p`. */
function bestRationalApprox(target: number, maxDenom: number): { p: number; q: number } {
    if (!Number.isFinite(target)) return { p: 0, q: 1 };
    const sign = target < 0 ? -1 : 1;
    const absT = Math.abs(target);
    let bestP = 0;
    let bestQ = 1;
    let bestErr = absT;
    for (let q = 1; q <= maxDenom; q++) {
        const p = Math.round(absT * q);
        const err = Math.abs(p / q - absT);
        if (err < bestErr - 1e-12) {
            bestP = p;
            bestQ = q;
            bestErr = err;
        }
    }
    return { p: sign * bestP, q: bestQ };
}

/** Build per-axis rates from a small-denominator approximation of the
 *  true lateral/primary ratios, then run the standard Bresenham core.
 *  The result is one clean repeating cycle of length ≤ `maxDenom`
 *  primary steps — followed by a short literal drain when the snap
 *  doesn't land exactly on `to`. */
function walkSnappedStairs(
    c: Cursor,
    to: Block3,
    maxDenom: number,
    path: Block3[],
    max: number,
): boolean {
    const dx = to.x - c.x;
    const dy = to.y - c.y;
    const dz = to.z - c.z;
    if (dx === 0 && dy === 0 && dz === 0) return true;
    const primary = dominantAxis(dx, dy, dz);
    const primaryDelta = primary === "x" ? dx : primary === "y" ? dy : dz;
    if (primaryDelta === 0) return walkBresenhamAuto(c, to, path, max);

    const lateralDelta: Record<Axis, number> = { x: dx, y: dy, z: dz };
    const rates: Record<Axis, number> = { x: 0, y: 0, z: 0 };
    for (const a of ["x", "y", "z"] as Axis[]) {
        if (a === primary) continue;
        const d = lateralDelta[a];
        if (d === 0) continue;
        const fit = bestRationalApprox(d / primaryDelta, maxDenom);
        // Rate magnitude only — sign is handled via `Math.sign(to-c)`
        // inside `walkBresenhamCore`.
        rates[a] = Math.abs(fit.p) / Math.max(1, fit.q);
    }
    return walkBresenhamCore(c, to, primary, rates, path, max);
}

/** Emit one Y step paired with one forward step, repeatedly, until Y
 *  matches `to.y`. When forward has already reached `to[fwdAxis]` the
 *  paired forward step is skipped (rare — only the last cycle of the
 *  ramp). */
function walkClimbPair(c: Cursor, to: Block3, fwdAxis: Axis, path: Block3[], max: number): boolean {
    if (c.y === to.y) return true;
    const ySign = Math.sign(to.y - c.y);
    const fwdSign = Math.sign(to[fwdAxis] - c[fwdAxis]);
    while (c.y !== to.y) {
        c.y += ySign;
        if (!emit(path, c, max)) return false;
        if (fwdSign !== 0 && c[fwdAxis] !== to[fwdAxis]) {
            c[fwdAxis] += fwdSign;
            if (!emit(path, c, max)) return false;
        }
    }
    return true;
}

/** Climb-first + snapped horizontal stairs. Two clean cycles in the
 *  breakdown: a `(1U 1F)`-style ramp, then a snug X/Z staircase.
 *  Easier to read than `vertical-first`, which uses raw Bresenham for
 *  the flat half and phase-fragments. */
function walkClimbThenStairs(
    c: Cursor,
    to: Block3,
    maxDenom: number,
    path: Block3[],
    max: number,
): boolean {
    const dx = to.x - c.x;
    const dz = to.z - c.z;
    const fwdAxis: Axis = Math.abs(dx) >= Math.abs(dz) && dx !== 0 ? "x" : "z";
    if (!walkClimbPair(c, to, fwdAxis, path, max)) return false;
    return walkSnappedStairs(c, to, maxDenom, path, max);
}

/** Snapped horizontal stairs + climb-last. Mirror of
 *  `walkClimbThenStairs`. Walks the flat half to a point pulled back
 *  by `|dy|` along the forward axis so the closing ramp lands
 *  exactly on `to`. */
function walkStairsThenClimb(
    c: Cursor,
    to: Block3,
    maxDenom: number,
    path: Block3[],
    max: number,
): boolean {
    const dy = Math.abs(to.y - c.y);
    if (dy === 0) return walkSnappedStairs(c, to, maxDenom, path, max);

    const dx = to.x - c.x;
    const dz = to.z - c.z;
    const fwdAxis: Axis = Math.abs(dx) >= Math.abs(dz) && dx !== 0 ? "x" : "z";
    const fwdSign = Math.sign(to[fwdAxis] - c[fwdAxis]);
    const horizFwd = Math.abs(to[fwdAxis] - c[fwdAxis]);
    const reserve = Math.min(dy, horizFwd);

    // Intermediate landing point: flat target pulled back along
    // forward by `reserve` so the closing ramp covers the gap.
    const mid: Block3 = { x: to.x, y: c.y, z: to.z };
    if (fwdAxis === "x") mid.x -= reserve * fwdSign;
    else mid.z -= reserve * fwdSign;

    if (!walkSnappedStairs(c, mid, maxDenom, path, max)) return false;
    return walkClimbPair(c, to, fwdAxis, path, max);
}

// ---------------------------------------------------------------------------
// 45° climb modes
// ---------------------------------------------------------------------------

/** Pick the horizontal axis to pair a Y move with — preferring the one
 *  with the larger remaining delta. Returns null if both are at target. */
function pickHorizontalPair(c: Cursor, to: Block3): Axis | null {
    const dx = to.x - c.x;
    const dz = to.z - c.z;
    if (dx === 0 && dz === 0) return null;
    if (Math.abs(dx) >= Math.abs(dz) && dx !== 0) return "x";
    return "z";
}

/** Walk horizontal Bresenham toward `to.x`/`to.z` (keeping cursor Y),
 *  stopping early once `|dx| + |dz|` ≤ `reserveAtEnd` so the caller
 *  can finish with a different pattern (e.g. the 45° climb). */
function walkBresenhamHorizontalReserved(
    c: Cursor,
    to: Block3,
    reserveAtEnd: number,
    path: Block3[],
    max: number,
): boolean {
    while (true) {
        const dx = to.x - c.x;
        const dz = to.z - c.z;
        if (Math.abs(dx) + Math.abs(dz) <= reserveAtEnd) return true;
        const ax: Axis = Math.abs(dx) >= Math.abs(dz) && dx !== 0 ? "x" : "z";
        const sgn = Math.sign(ax === "x" ? dx : dz);
        if (sgn === 0) return true;
        c[ax] += sgn;
        if (!emit(path, c, max)) return false;
    }
}

/** Climb-first: alternate a single ±Y step with a single ±horizontal
 *  step (toward target on the dominant horizontal axis with remaining
 *  delta) until Y matches; then drain any remaining horizontal with a
 *  flat Bresenham. The result reads as a 45° staircase out of the
 *  start TL, transitioning to flat tunnel. */
function walkClimb45First(c: Cursor, to: Block3, path: Block3[], max: number): boolean {
    const ySign = Math.sign(to.y - c.y);
    while (c.y !== to.y) {
        c.y += ySign;
        if (!emit(path, c, max)) return false;
        const ax = pickHorizontalPair(c, to);
        if (ax) {
            c[ax] += Math.sign(to[ax] - c[ax]);
            if (!emit(path, c, max)) return false;
        }
    }
    return walkBresenhamHorizontal(c, to, path, max);
}

/** Climb-last: flat Bresenham first (consuming all but the horizontal
 *  blocks reserved for the climb), then a 45° staircase that lands on
 *  the end TL. Reserve = min(|dy|, total horizontal Manhattan) so the
 *  climb pairs each ±Y with one horizontal step. */
function walkClimb45Last(c: Cursor, to: Block3, path: Block3[], max: number): boolean {
    const dy = Math.abs(to.y - c.y);
    if (dy === 0) {
        return walkBresenhamHorizontal(c, to, path, max);
    }
    const horizTotal = Math.abs(to.x - c.x) + Math.abs(to.z - c.z);
    const reserve = Math.min(dy, horizTotal);

    if (!walkBresenhamHorizontalReserved(c, to, reserve, path, max)) return false;

    const ySign = Math.sign(to.y - c.y);
    while (c.y !== to.y) {
        c.y += ySign;
        if (!emit(path, c, max)) return false;
        const ax = pickHorizontalPair(c, to);
        if (ax) {
            c[ax] += Math.sign(to[ax] - c[ax]);
            if (!emit(path, c, max)) return false;
        }
    }
    // Safety: drain any horizontal leftover (shouldn't normally happen).
    if (!walkAxis(c, "x", to.x, path, max)) return false;
    return walkAxis(c, "z", to.z, path, max);
}

// ---------------------------------------------------------------------------
// Sequence mode
// ---------------------------------------------------------------------------

/** Parse a free-form sequence string into a list of `{dir, count}`
 *  moves. Whitespace, commas, slashes, parentheses are all treated as
 *  separators; case is ignored; unknown characters are skipped silently.
 *  A bare direction letter (`"U"`) defaults to count 1. */
export function parseSequenceTokens(input: string): SequenceToken[] {
    if (!input) return [];
    const tokens: SequenceToken[] = [];
    const re = /(\d+)?\s*([UDFBLRudfblr])/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(input)) !== null) {
        const count = match[1] ? Math.max(1, Math.min(64, parseInt(match[1], 10))) : 1;
        const dir = match[2].toUpperCase() as SequenceDir;
        tokens.push({ dir, count });
    }
    return tokens;
}

/** Resolve direction letters into concrete (axis, sign) pairs. Forward
 *  = dominant horizontal axis toward `to`. Right = 90° clockwise from
 *  forward viewed from above (e.g. facing east → right is south). */
function directionResolver(from: Cursor, to: Block3) {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const fwdAxis: Axis = Math.abs(dx) >= Math.abs(dz) && dx !== 0 ? "x" : "z";
    const fwdSign = Math.sign(fwdAxis === "x" ? dx : dz) || 1;
    const rightAxis: Axis = fwdAxis === "x" ? "z" : "x";
    // Clockwise-from-above convention: facing +x → right is +z;
    // facing +z → right is -x; facing -x → -z; facing -z → +x.
    const rightSign = fwdAxis === "x" ? fwdSign : -fwdSign;
    return (dir: SequenceDir): { axis: Axis; sign: number } => {
        switch (dir) {
            case "U": return { axis: "y", sign: 1 };
            case "D": return { axis: "y", sign: -1 };
            case "F": return { axis: fwdAxis, sign: fwdSign };
            case "B": return { axis: fwdAxis, sign: -fwdSign };
            case "R": return { axis: rightAxis, sign: rightSign };
            case "L": return { axis: rightAxis, sign: -rightSign };
        }
    };
}

/** Custom move-sequence walker. Loops the token list until the cursor
 *  reaches `to`. Token moves are skipped when the matching axis is
 *  already at target or moving in the requested direction would
 *  overshoot. Falls back to a clean drain (Y → forward → right) for
 *  any leftover after the sequence runs out of progress. Padding is
 *  applied by the outer wrapper, not here. */
function walkSequence(
    c: Cursor,
    to: Block3,
    sequence: string,
    path: Block3[],
    max: number,
): boolean {
    const tokens = parseSequenceTokens(sequence);
    if (tokens.length === 0) {
        // No usable tokens — fall back to the safest mode.
        return walkBresenhamAuto(c, to, path, max);
    }

    const dx = to.x - c.x;
    const dz = to.z - c.z;
    const fwdAxis: Axis = Math.abs(dx) >= Math.abs(dz) && dx !== 0 ? "x" : "z";
    const rightAxis: Axis = fwdAxis === "x" ? "z" : "x";
    const resolve = directionResolver(c, to);

    // Pattern loop. Stop when fully aligned, or when no token in a
    // full pass made progress (sequence direction conflicts target).
    const safetyCap = Math.max(1, max * 2);
    let iter = 0;
    while (iter++ < safetyCap) {
        if (c.x === to.x && c.y === to.y && c.z === to.z) break;

        let progress = false;
        for (const token of tokens) {
            const { axis, sign } = resolve(token.dir);
            for (let i = 0; i < token.count; i++) {
                const rem = to[axis] - c[axis];
                if (rem === 0) continue;
                if (Math.sign(rem) !== sign) continue;
                c[axis] += sign;
                if (!emit(path, c, max)) return false;
                progress = true;
            }
        }
        if (!progress) break;
    }

    // Drain Y first (climb correction), then forward, then right.
    // Each `walkAxis` is single-axis ±1 so face-adjacency holds.
    if (!walkAxis(c, "y", to.y, path, max)) return false;
    if (!walkAxis(c, fwdAxis, to[fwdAxis], path, max)) return false;
    return walkAxis(c, rightAxis, to[rightAxis], path, max);
}

export interface PathStats {
    totalBlocks: number;
    straightLineBlocks: number;
    /** Approximate distance the player actually traverses through the
     *  finished tunnel. Pure same-axis runs count at full length, but
     *  alternating-axis runs (Bresenham/zigzag) collapse to their
     *  Euclidean diagonal — modelling that the player can sprint
     *  diagonally through a checker-pattern but has to walk both legs
     *  of a hard L-shape. */
    walkableLength: number;
    lengthRatio: number;
    maxDeviation: number;
    rmsDeviation: number;
    /** How many blocks in the path are marked as slabs. Zero unless
     *  the user enabled `useSlabs`. */
    slabBlocks: number;
}

/** Distance from a point to the infinite line passing through a→b in 3D. */
function pointLineDistance(p: Block3, a: Block3, b: Block3): number {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const apx = p.x - a.x;
    const apy = p.y - a.y;
    const apz = p.z - a.z;
    const cx = aby * apz - abz * apy;
    const cy = abz * apx - abx * apz;
    const cz = abx * apy - aby * apx;
    const crossMag = Math.hypot(cx, cy, cz);
    const abMag = Math.hypot(abx, aby, abz);
    if (abMag === 0) return Math.hypot(apx, apy, apz);
    return crossMag / abMag;
}

function stepAxisOf(a: Block3, b: Block3): Axis {
    if (b.x !== a.x) return "x";
    if (b.y !== a.y) return "y";
    return "z";
}

/** Walkable length: split the path into "alternating chunks" — within
 *  each chunk no two consecutive steps share an axis once a switch has
 *  occurred — and replace each chunk with its Euclidean start→end
 *  distance. Same-axis runs stay at full length, perfect zigzags
 *  collapse to the diagonal. */
function computeWalkableLength(path: Block3[]): number {
    if (path.length < 2) return 0;
    let total = 0;
    let chunkStartIdx = 0;
    let lastAxis: Axis | null = null;
    let switched = false;
    for (let i = 1; i < path.length; i++) {
        const ax = stepAxisOf(path[i - 1], path[i]);
        const repeat = ax === lastAxis;
        if (switched && repeat) {
            const a = path[chunkStartIdx];
            const b = path[i - 1];
            total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
            chunkStartIdx = i - 1;
            switched = false;
        } else if (lastAxis !== null && !repeat) {
            switched = true;
        }
        lastAxis = ax;
    }
    const a = path[chunkStartIdx];
    const b = path[path.length - 1];
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    return total;
}

export function pathStats(path: PathBlock[], from: Block3, to: Block3): PathStats {
    const totalBlocks = Math.max(0, path.length - 1);
    const straightLineBlocks = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const walkableLength = computeWalkableLength(path);
    const lengthRatio = straightLineBlocks > 0 ? totalBlocks / straightLineBlocks : 0;
    let maxDev = 0;
    let sumSq = 0;
    let slabBlocks = 0;
    for (const b of path) {
        const d = pointLineDistance(b, from, to);
        if (d > maxDev) maxDev = d;
        sumSq += d * d;
        if (b.slab) slabBlocks += 1;
    }
    const rms = path.length > 0 ? Math.sqrt(sumSq / path.length) : 0;
    return {
        totalBlocks,
        straightLineBlocks,
        walkableLength,
        lengthRatio,
        maxDeviation: maxDev,
        rmsDeviation: rms,
        slabBlocks,
    };
}

export interface PathBounds {
    min: Block3;
    max: Block3;
}

export function pathBounds(path: Block3[]): PathBounds {
    if (path.length === 0) {
        return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    }
    let minX = path[0].x, minY = path[0].y, minZ = path[0].z;
    let maxX = minX, maxY = minY, maxZ = minZ;
    for (const b of path) {
        if (b.x < minX) minX = b.x;
        else if (b.x > maxX) maxX = b.x;
        if (b.y < minY) minY = b.y;
        else if (b.y > maxY) maxY = b.y;
        if (b.z < minZ) minZ = b.z;
        else if (b.z > maxZ) maxZ = b.z;
    }
    return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

export const TUNNEL_MAX_BLOCKS = 5000;

// ---------------------------------------------------------------------------
// Pattern introspection: turn a generated path back into a sequence-style
// readout so non-sequence modes are also auditable. Same forward/right
// resolution as `directionResolver` so the readout matches sequence mode's
// vocabulary (F/B/L/R/U/D).
// ---------------------------------------------------------------------------

export interface PathPatternSummary {
    /** Full RLE'd token list of the path (incl. padding F runs). */
    tokens: SequenceToken[];
    /** Tokens before the first detected phase — typically the start
     *  padding F run, or empty. */
    leading: SequenceToken[];
    /** Ordered list of phases the middle of the path was decomposed
     *  into. A `kind: "cycle"` phase is a sub-sequence that repeats N
     *  consecutive times; a `kind: "literal"` phase is a contiguous
     *  stretch with no detectable repeat (a transition between
     *  cycles). */
    phases: PatternPhase[];
    /** Tokens after the last phase — typically the end padding F run. */
    trailing: SequenceToken[];
    /** True iff any phase is a cycle (so the breakdown is more than
     *  just a flat token dump). */
    hasCycle: boolean;
}

export type PatternPhase =
    | { kind: "cycle"; cycle: SequenceToken[]; repeats: number }
    | { kind: "literal"; tokens: SequenceToken[] };

/** Convert a path into a list of single-block moves expressed as
 *  forward/right-relative direction letters, then run-length encode
 *  consecutive identical directions. Forward = dominant horizontal
 *  axis from→to; right = clockwise-from-above of forward. */
export function pathToDirectionTokens(
    path: Block3[],
    from: Block3,
    to: Block3,
): SequenceToken[] {
    if (path.length < 2) return [];
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const fwdAxis: Axis = Math.abs(dx) >= Math.abs(dz) && dx !== 0 ? "x" : "z";
    const fwdSign = Math.sign(fwdAxis === "x" ? dx : dz) || 1;
    const rightAxis: Axis = fwdAxis === "x" ? "z" : "x";
    const rightSign = fwdAxis === "x" ? fwdSign : -fwdSign;

    const moveToDir = (axis: Axis, sign: number): SequenceDir => {
        if (axis === "y") return sign > 0 ? "U" : "D";
        if (axis === fwdAxis) return sign === fwdSign ? "F" : "B";
        return sign === rightSign ? "R" : "L";
    };

    const out: SequenceToken[] = [];
    for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const b = path[i];
        let axis: Axis = "x";
        let sign = 0;
        if (b.x !== a.x) {
            axis = "x";
            sign = b.x - a.x;
        } else if (b.y !== a.y) {
            axis = "y";
            sign = b.y - a.y;
        } else if (b.z !== a.z) {
            axis = "z";
            sign = b.z - a.z;
        }
        if (sign === 0) continue;
        const dir = moveToDir(axis, sign);
        const last = out[out.length - 1];
        if (last && last.dir === dir) last.count += 1;
        else out.push({ dir, count: 1 });
    }
    return out;
}

function tokensEqual(a: SequenceToken[], b: SequenceToken[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].dir !== b[i].dir || a[i].count !== b[i].count) return false;
    }
    return true;
}

/** Starting at index `start` in `mid`, find the smallest period `p`
 *  whose prefix repeats consecutively at least twice. Returns the
 *  cycle and how many copies fit, or null. Smallest-p-first
 *  maximizes compression and matches what a human would call "the"
 *  repeating unit (e.g. `(1D 1F)` over `(1D 1F 1D 1F)`).
 *
 *  Caps the period at `MAX_CYCLE_LEN` — cycles longer than that are
 *  visually useless ("here's a 200-token unit repeating twice"), and
 *  the cap keeps the algorithm O(n × MAX_CYCLE_LEN) instead of O(n²)
 *  per position. */
const MAX_CYCLE_LEN = 32;
function findCycleAt(
    mid: SequenceToken[],
    start: number,
): { cycle: SequenceToken[]; repeats: number } | null {
    const remaining = mid.length - start;
    if (remaining < 2) return null;
    const maxP = Math.min(MAX_CYCLE_LEN, Math.floor(remaining / 2));
    for (let p = 1; p <= maxP; p++) {
        const head = mid.slice(start, start + p);
        let repeats = 1;
        let i = start + p;
        while (i + p <= mid.length && tokensEqual(mid.slice(i, i + p), head)) {
            repeats += 1;
            i += p;
        }
        if (repeats >= 2) {
            return { cycle: head, repeats };
        }
    }
    return null;
}

/** Walk `mid` left-to-right, greedily extracting cycle phases. When a
 *  position has no cycle, accumulate literal tokens until a cycle is
 *  again found — that literal stretch becomes a transition phase. The
 *  result is a flat ordered list of `cycle`/`literal` phases that
 *  exactly reproduces `mid` when concatenated. */
function detectPhases(mid: SequenceToken[]): PatternPhase[] {
    const phases: PatternPhase[] = [];
    let literalStart = -1;
    let i = 0;
    const flushLiteral = (endExclusive: number) => {
        if (literalStart >= 0 && endExclusive > literalStart) {
            phases.push({ kind: "literal", tokens: mid.slice(literalStart, endExclusive) });
        }
        literalStart = -1;
    };
    while (i < mid.length) {
        const found = findCycleAt(mid, i);
        if (found) {
            flushLiteral(i);
            phases.push({ kind: "cycle", cycle: found.cycle, repeats: found.repeats });
            i += found.cycle.length * found.repeats;
        } else {
            if (literalStart < 0) literalStart = i;
            i += 1;
        }
    }
    flushLiteral(mid.length);
    return phases;
}

/** Strip up to 1 leading and/or 1 trailing pure-`F` token (the
 *  configured straight padding shows up as exactly one F token at
 *  each end after RLE). Returns the requested split. */
function splitPadding(
    tokens: SequenceToken[],
    stripLead: boolean,
    stripTrail: boolean,
): {
    leading: SequenceToken[];
    middle: SequenceToken[];
    trailing: SequenceToken[];
} {
    const startIdx = stripLead && tokens.length > 0 && tokens[0].dir === "F" ? 1 : 0;
    const endIdx =
        stripTrail && tokens.length - 1 > startIdx && tokens[tokens.length - 1].dir === "F"
            ? tokens.length - 1
            : tokens.length;
    return {
        leading: tokens.slice(0, startIdx),
        middle: tokens.slice(startIdx, endIdx),
        trailing: tokens.slice(endIdx),
    };
}

/** Token count "explained" by cycles in a phase list — sum of
 *  `cycle.length * repeats` across `cycle` phases. Used to pick the
 *  best padding-strip variant. */
function phasesExplained(phases: PatternPhase[]): number {
    let n = 0;
    for (const p of phases) {
        if (p.kind === "cycle") n += p.cycle.length * p.repeats;
    }
    return n;
}

/** Decompose the path into leading padding + phase list + trailing
 *  padding. Each phase is either a repeated cycle or a literal
 *  transition between cycles. This handles paths that are made of
 *  multiple consecutive cycles (very common for Bresenham-style modes
 *  where the integer accumulator transitions between sub-patterns). */
export function summarizePathPattern(
    path: Block3[],
    from: Block3,
    to: Block3,
): PathPatternSummary {
    const tokens = pathToDirectionTokens(path, from, to);
    if (tokens.length === 0) {
        return { tokens, leading: [], phases: [], trailing: [], hasCycle: false };
    }

    // Try all four padding-strip variants; pick the one whose phase
    // decomposition explains the most tokens via cycles. Ties go to
    // the variant that strips fewer tokens so we don't hide structure
    // when there is no padding.
    let best: {
        leading: SequenceToken[];
        phases: PatternPhase[];
        trailing: SequenceToken[];
        explained: number;
        stripped: number;
    } | null = null;

    for (const stripLead of [false, true]) {
        for (const stripTrail of [false, true]) {
            const { leading, middle, trailing } = splitPadding(tokens, stripLead, stripTrail);
            const phases = detectPhases(middle);
            const explained = phasesExplained(phases);
            const stripped = leading.length + trailing.length;
            if (
                !best ||
                explained > best.explained ||
                (explained === best.explained && stripped < best.stripped)
            ) {
                best = { leading, phases, trailing, explained, stripped };
            }
        }
    }

    const chosen = best ?? {
        leading: [],
        phases: [{ kind: "literal" as const, tokens }],
        trailing: [],
    };
    const hasCycle = chosen.phases.some((p) => p.kind === "cycle");
    return {
        tokens,
        leading: chosen.leading,
        phases: chosen.phases,
        trailing: chosen.trailing,
        hasCycle,
    };
}

/** Render an RLE token list back into the user-facing string format
 *  (e.g. `[{count:2, dir:"F"}, {count:1, dir:"U"}]` → `"2F 1U"`). */
export function formatTokens(tokens: SequenceToken[]): string {
    return tokens.map((t) => `${t.count}${t.dir}`).join(" ");
}

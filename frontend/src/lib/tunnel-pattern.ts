// Pattern + path generation for the tunnel-builder tool.
//
// All math is integer-block: positions are unit-cube voxels in
// Vintage Story world coords (+X east, +Y up, +Z south). Every block
// in a generated path is **face-adjacent** to its neighbour (exactly
// one of x/y/z differs by ±1) — the supercover-line invariant — so
// the result is diggable as a single connected tunnel.

import type { Block3 } from "./tunnel-share";

export type Axis = "x" | "y" | "z";

/** High-level tunnel shape. Only `"stepped"` consumes the per-axis
 *  step counts; only `"sequence"` consumes `sequence` + `padding`. */
export type TunnelMode =
    | "bresenham"
    | "vertical-first"
    | "vertical-last"
    | "stepped"
    | "sequence";

export const TUNNEL_MODES: ReadonlyArray<TunnelMode> = [
    "bresenham",
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
}

export const DEFAULT_SEQUENCE = "1U 1F";
export const DEFAULT_PADDING = 2;
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
): Block3[] {
    const path: Block3[] = [{ x: from.x, y: from.y, z: from.z }];
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
    const padReq = Math.max(0, Math.min(MAX_PADDING, Math.trunc(pattern.padding ?? 0)));
    // Cap padding so start + end stretches don't overlap and we have
    // at least one block left for the mode walker.
    const padding =
        fwdSign === 0 ? 0 : Math.min(padReq, Math.max(0, Math.floor((Math.abs(fwdDelta) - 1) / 2)));

    // Start padding: pure forward.
    for (let i = 0; i < padding; i++) {
        c[fwdAxis] += fwdSign;
        if (!emit(path, c, maxBlocks)) return path;
    }

    // Inner target = `to` shifted backward along forward axis so the
    // mode walker stops short and the tail padding lands on `to`.
    const innerTo: Block3 = { x: to.x, y: to.y, z: to.z };
    if (fwdAxis === "x") innerTo.x -= padding * fwdSign;
    else innerTo.z -= padding * fwdSign;

    switch (mode) {
        case "vertical-first":
            walkClimb45First(c, innerTo, path, maxBlocks);
            break;
        case "vertical-last":
            walkClimb45Last(c, innerTo, path, maxBlocks);
            break;
        case "stepped":
            walkStepped(c, innerTo, pattern, path, maxBlocks);
            break;
        case "sequence":
            walkSequence(c, innerTo, pattern.sequence, path, maxBlocks);
            break;
        case "bresenham":
        default:
            walkBresenhamAuto(c, innerTo, path, maxBlocks);
            break;
    }

    // End padding: pure forward to land on `to`. Defensive: only step
    // while we're still short of the target so an unexpectedly-long
    // walker can't push us past.
    while (c[fwdAxis] !== to[fwdAxis]) {
        c[fwdAxis] += fwdSign;
        if (!emit(path, c, maxBlocks)) return path;
    }

    return path;
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

export function pathStats(path: Block3[], from: Block3, to: Block3): PathStats {
    const totalBlocks = Math.max(0, path.length - 1);
    const straightLineBlocks = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const walkableLength = computeWalkableLength(path);
    const lengthRatio = straightLineBlocks > 0 ? totalBlocks / straightLineBlocks : 0;
    let maxDev = 0;
    let sumSq = 0;
    for (const b of path) {
        const d = pointLineDistance(b, from, to);
        if (d > maxDev) maxDev = d;
        sumSq += d * d;
    }
    const rms = path.length > 0 ? Math.sqrt(sumSq / path.length) : 0;
    return {
        totalBlocks,
        straightLineBlocks,
        walkableLength,
        lengthRatio,
        maxDeviation: maxDev,
        rmsDeviation: rms,
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

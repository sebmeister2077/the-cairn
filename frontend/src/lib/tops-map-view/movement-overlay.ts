// Builds the admin "movement" overlay for the TOPS map from aggregated
// planned-route analytics (`adminRoutePlanner.map`): an endpoint density
// raster plus weighted route-flow segments. Mirrors the player-claim
// density raster approach so the viewer can blit it cheaply each frame.

import type { PlayerClaimDensity } from "@/hooks/usePlayerClaims";

export interface WeightedPoint {
    x: number;
    z: number;
    weight: number;
}

export interface MovementFlow {
    from: { x: number; z: number };
    to: { x: number; z: number };
    kind: "walk" | "tl";
    weight: number;
}

export interface MovementOverlayData {
    /** Endpoint concentration raster, or null when there is no data. */
    density: PlayerClaimDensity | null;
    /** 0..1 opacity the viewer blits the raster at. */
    densityOpacity: number;
    /** Weighted route-flow segments. */
    flows: MovementFlow[];
    /** Largest flow weight — used to normalise line width/alpha. */
    maxWeight: number;
}

// Perceptual ramp (transparent → blue → cyan → lime → yellow → red).
const DENSITY_RAMP: Array<[number, number, number, number]> = [
    [0, 0, 0, 0],
    [59, 130, 246, 90],
    [34, 211, 238, 150],
    [163, 230, 53, 190],
    [250, 204, 21, 220],
    [239, 68, 68, 245],
];

function sampleRamp(t: number): [number, number, number, number] {
    const clamped = Math.max(0, Math.min(1, t));
    const scaled = clamped * (DENSITY_RAMP.length - 1);
    const i = Math.min(DENSITY_RAMP.length - 2, Math.floor(scaled));
    const f = scaled - i;
    const a = DENSITY_RAMP[i];
    const b = DENSITY_RAMP[i + 1];
    return [
        a[0] + (b[0] - a[0]) * f,
        a[1] + (b[1] - a[1]) * f,
        a[2] + (b[2] - a[2]) * f,
        a[3] + (b[3] - a[3]) * f,
    ];
}

function boxBlur(grid: Float32Array, cols: number, rows: number, radius: number): Float32Array {
    if (radius <= 0) return grid;
    const tmp = new Float32Array(grid.length);
    const out = new Float32Array(grid.length);
    const win = radius * 2 + 1;
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            let sum = 0;
            for (let k = -radius; k <= radius; k++) {
                const xx = Math.max(0, Math.min(cols - 1, x + k));
                sum += grid[y * cols + xx];
            }
            tmp[y * cols + x] = sum / win;
        }
    }
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            let sum = 0;
            for (let k = -radius; k <= radius; k++) {
                const yy = Math.max(0, Math.min(rows - 1, y + k));
                sum += tmp[yy * cols + x];
            }
            out[y * cols + x] = sum / win;
        }
    }
    return out;
}

/**
 * Build a weighted concentration heatmap raster. Bins each point's weight
 * into a spawn-relative grid (capped to `maxDim` cells per axis), blurs,
 * then colour-maps by normalised density. Returns null when empty.
 */
export function buildWeightedDensity(
    points: WeightedPoint[],
    maxDim = 1024,
): PlayerClaimDensity | null {
    if (points.length === 0) return null;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
    }
    const pad = 64;
    minX -= pad;
    minZ -= pad;
    maxX += pad;
    maxZ += pad;
    const extentX = Math.max(1, maxX - minX);
    const extentZ = Math.max(1, maxZ - minZ);
    const blocksPerCell = Math.max(16, Math.ceil(Math.max(extentX, extentZ) / maxDim));
    const cols = Math.max(1, Math.ceil(extentX / blocksPerCell));
    const rows = Math.max(1, Math.ceil(extentZ / blocksPerCell));

    const grid = new Float32Array(cols * rows);
    for (const p of points) {
        const gx = Math.min(cols - 1, Math.floor((p.x - minX) / blocksPerCell));
        const gz = Math.min(rows - 1, Math.floor((p.z - minZ) / blocksPerCell));
        grid[gz * cols + gx] += Math.max(0, p.weight);
    }
    const blurred = boxBlur(grid, cols, rows, 1);
    const nonZero: number[] = [];
    for (let i = 0; i < blurred.length; i++) if (blurred[i] > 0) nonZero.push(blurred[i]);
    if (nonZero.length === 0) return null;
    nonZero.sort((a, b) => a - b);
    const norm =
        nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * 0.98))] ||
        nonZero[nonZero.length - 1];
    if (norm <= 0) return null;

    const canvas = document.createElement("canvas");
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const img = ctx.createImageData(cols, rows);
    for (let i = 0; i < blurred.length; i++) {
        const t = Math.sqrt(blurred[i] / norm);
        const [r, g, b, a] = sampleRamp(t);
        const o = i * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = a;
    }
    ctx.putImageData(img, 0, 0);

    return { canvas, originX: minX, originZ: minZ, blocksPerCell, cols, rows };
}

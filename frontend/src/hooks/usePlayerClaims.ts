// React Query loader for the static player land-claim boxes bundled with the
// frontend (`frontend/src/assets/MapFeaturesJson/map-features.playerclaims.json`,
// emitted by the VsClayProxy `--map-export` split writer). These are the ~5k
// player-owned claim volumes across the explored world.
//
// center/min/max X/Z are spawn-relative (matching the in-game HUD) and are used
// directly for map positioning — the same convention as the recorded traders /
// trader-claims overlays (see useTraderClaims / useRecordedMapFeatures). Y is
// absolute world height and is not used for positioning.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

interface RawVec3 {
    x: number;
    y: number;
    z: number;
}

interface RawPlayerClaim {
    playerUid?: string;
    owner?: string;
    description?: string;
    areaCount?: number;
    center?: Partial<RawVec3>;
    min?: Partial<RawVec3>;
    max?: Partial<RawVec3>;
}

interface RawClaimFile {
    features?: RawPlayerClaim[];
}

export interface PlayerClaim {
    playerUid: string;
    /** Owner display name as recorded, e.g. "Player Pepevog". */
    owner: string;
    description: string;
    /** Spawn-relative centre used for map positioning. */
    x: number;
    z: number;
    /** Spawn-relative footprint (X/Z) derived from min/max, for search markers. */
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
}

export const PLAYER_CLAIMS_QUERY_KEY = ["player-claims"] as const;

function isFiniteNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

function parsePlayerClaims(features: RawPlayerClaim[]): PlayerClaim[] {
    const out: PlayerClaim[] = [];
    for (const c of features) {
        const center = c.center;
        if (!center || !isFiniteNumber(center.x) || !isFiniteNumber(center.z)) continue;
        const min = c.min ?? {};
        const max = c.max ?? {};
        const minX = isFiniteNumber(min.x) ? min.x : center.x;
        const minZ = isFiniteNumber(min.z) ? min.z : center.z;
        const maxX = isFiniteNumber(max.x) ? max.x : center.x;
        const maxZ = isFiniteNumber(max.z) ? max.z : center.z;
        out.push({
            playerUid: typeof c.playerUid === "string" ? c.playerUid : "",
            owner: typeof c.owner === "string" ? c.owner : "",
            description: typeof c.description === "string" ? c.description : "",
            x: center.x,
            z: center.z,
            minX,
            minZ,
            maxX,
            maxZ,
        });
    }
    return out;
}

/**
 * Load + parse the static player-claim boxes. Pass `enabled: false` to keep the
 * (large) dynamic import from downloading until the overlay toggle is on.
 */
export function usePlayerClaims(enabled: boolean): UseQueryResult<PlayerClaim[]> {
    return useQuery<PlayerClaim[]>({
        queryKey: [...PLAYER_CLAIMS_QUERY_KEY],
        enabled,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: async () => {
            const mod = (await import(
                "@/assets/MapFeaturesJson/map-features.playerclaims.json"
            )) as { default: RawClaimFile };
            return parsePlayerClaims(mod.default?.features ?? []);
        },
    });
}

export interface PlayerClaimDensity {
    /** Off-screen raster (cols×rows px) coloured by claim concentration. */
    canvas: HTMLCanvasElement;
    /** Spawn-relative world X of the raster's left edge. */
    originX: number;
    /** Spawn-relative world Z of the raster's top edge. */
    originZ: number;
    /** World blocks represented by a single raster pixel. */
    blocksPerCell: number;
    cols: number;
    rows: number;
}

// Perceptual ramp (transparent → blue → cyan → green → yellow → red).
const DENSITY_RAMP: Array<[number, number, number, number]> = [
    [0, 0, 0, 0],
    [59, 130, 246, 90], // blue
    [34, 211, 238, 150], // cyan
    [163, 230, 53, 190], // lime
    [250, 204, 21, 220], // yellow
    [239, 68, 68, 245], // red
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

// Separable box blur over the density grid for a smooth heatmap.
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
 * Build a claim-concentration heatmap raster from the parsed claims. Bins claim
 * centres into a spawn-relative grid (capped to `maxDim` cells per axis so the
 * raster stays small however far the claims spread), blurs, then colour-maps by
 * normalised density. Cheap to draw: the viewer blits this once per frame.
 */
export function buildPlayerClaimDensity(
    claims: PlayerClaim[],
    maxDim = 1024,
): PlayerClaimDensity | null {
    if (claims.length === 0) return null;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const c of claims) {
        if (c.x < minX) minX = c.x;
        if (c.x > maxX) maxX = c.x;
        if (c.z < minZ) minZ = c.z;
        if (c.z > maxZ) maxZ = c.z;
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
    for (const c of claims) {
        const gx = Math.min(cols - 1, Math.floor((c.x - minX) / blocksPerCell));
        const gz = Math.min(rows - 1, Math.floor((c.z - minZ) / blocksPerCell));
        grid[gz * cols + gx] += 1;
    }
    const blurred = boxBlur(grid, cols, rows, 1);
    // Normalise to a high percentile of the non-empty cells rather than the
    // absolute peak, so the ultra-dense spawn region saturates to the top of
    // the ramp instead of compressing the rest of the world into the low
    // (near-transparent) end and reading as "spawn boiling, nothing else".
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
        // sqrt keeps low-density areas visible without washing out hotspots;
        // sampleRamp clamps t so anything above the percentile pins to red.
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

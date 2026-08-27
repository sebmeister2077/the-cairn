// Runtime loader for the temporal-stability depth-slice rasters.
//
// The PNGs are large (8000×8000 → ~2.3 GB across 13 slices × color + raw), so
// they are NOT committed or bundled into the Vite build. Instead they live in
// the public R2 bucket under `stability/<basename>/` and are fetched at
// runtime, mirroring `mapFeatures.ts` / `auction.ts`. Only the tiny georef
// `world.json` files + the summary JSON (a few hundred bytes each) stay
// bundled — they're needed synchronously for overlay bounds + the legend.
//
// Cache-busting: the timestamped `STABILITY_BASE_NAME` is baked into every URL
// path, so a re-export (new folder name) yields brand-new URLs and old cached
// copies fall out naturally. To refresh: upload the new export to R2 under
// `stability/<newBasename>/`, drop the new `*.world.json` + summary JSON into
// `src/assets/Stability/<newBasename>/`, and bump `STABILITY_BASE_NAME`.

import stabilityRootJson from "@/assets/Stability/tempstab_20260827_140807/tempstab_20260827_140807.json";

import y10WorldJson from "@/assets/Stability/tempstab_20260827_140807/tempstab_20260827_140807_y10.world.json";
import y20WorldJson from "@/assets/Stability/tempstab_20260827_140807/tempstab_20260827_140807_y20.world.json";
import y30WorldJson from "@/assets/Stability/tempstab_20260827_140807/tempstab_20260827_140807_y30.world.json";
import y40WorldJson from "@/assets/Stability/tempstab_20260827_140807/tempstab_20260827_140807_y40.world.json";
import y50WorldJson from "@/assets/Stability/tempstab_20260827_140807/tempstab_20260827_140807_y50.world.json";
import y60WorldJson from "@/assets/Stability/tempstab_20260827_140807/tempstab_20260827_140807_y60.world.json";
import y70WorldJson from "@/assets/Stability/tempstab_20260827_140807/tempstab_20260827_140807_y70.world.json";
import y80WorldJson from "@/assets/Stability/tempstab_20260827_140807/tempstab_20260827_140807_y80.world.json";
import y90WorldJson from "@/assets/Stability/tempstab_20260827_140807/tempstab_20260827_140807_y90.world.json";
import y100WorldJson from "@/assets/Stability/tempstab_20260827_140807/tempstab_20260827_140807_y100.world.json";
import y110WorldJson from "@/assets/Stability/tempstab_20260827_140807/tempstab_20260827_140807_y110.world.json";
import y120WorldJson from "@/assets/Stability/tempstab_20260827_140807/tempstab_20260827_140807_y120.world.json";
import y130WorldJson from "@/assets/Stability/tempstab_20260827_140807/tempstab_20260827_140807_y130.world.json";

import { decodePng } from "../png";
import {
    decodeStability,
    type LoadedStabilityColor,
    type LoadedStabilityRaw,
    type StabilityRootMeta,
    type StabilitySliceMeta,
    type StabilityWorld,
    type StabilityYSlice,
} from "./types";

/** Timestamped export folder name; also the R2 path segment + cache-buster. */
const STABILITY_BASE_NAME = "tempstab_20260827_140807";

const publicBucketOrigin = import.meta.env.VITE_PUBLIC_BUCKET_ORIGIN?.replace(/\/+$/, "");

/** Build the R2 URL for one slice's PNG. `null` when no bucket is configured. */
function sliceUrl(y: StabilityYSlice, raw: boolean): string | null {
    if (!publicBucketOrigin) return null;
    const suffix = raw ? "raw.png" : "png";
    return `${publicBucketOrigin}/stability/${STABILITY_BASE_NAME}/${STABILITY_BASE_NAME}_y${y}.${suffix}`;
}

const WORLDS: Record<StabilityYSlice, StabilityWorld> = {
    10: y10WorldJson as StabilityWorld,
    20: y20WorldJson as StabilityWorld,
    30: y30WorldJson as StabilityWorld,
    40: y40WorldJson as StabilityWorld,
    50: y50WorldJson as StabilityWorld,
    60: y60WorldJson as StabilityWorld,
    70: y70WorldJson as StabilityWorld,
    80: y80WorldJson as StabilityWorld,
    90: y90WorldJson as StabilityWorld,
    100: y100WorldJson as StabilityWorld,
    110: y110WorldJson as StabilityWorld,
    120: y120WorldJson as StabilityWorld,
    130: y130WorldJson as StabilityWorld,
};

const ROOT_META: StabilityRootMeta = stabilityRootJson as StabilityRootMeta;

export function getStabilityRootMeta(): StabilityRootMeta {
    return ROOT_META;
}

export function getStabilitySliceMeta(y: StabilityYSlice): StabilitySliceMeta | null {
    return ROOT_META.slices.find((s) => s.y === y) ?? null;
}

export function getStabilityWorld(y: StabilityYSlice): StabilityWorld {
    return WORLDS[y];
}

const colorCache = new Map<StabilityYSlice, Promise<LoadedStabilityColor>>();
const rawCache = new Map<StabilityYSlice, Promise<LoadedStabilityRaw>>();

const R2_REQUIRED =
    "Temporal-stability rasters are hosted on R2; set VITE_PUBLIC_BUCKET_ORIGIN.";

function resolveColor(y: StabilityYSlice): LoadedStabilityColor {
    const url = sliceUrl(y, false);
    if (!url) throw new Error(R2_REQUIRED);
    const world = WORLDS[y];
    // The browser renders the R2 PNG directly; we only surface dimensions + georef.
    return { y, url, width: world.widthPx, height: world.heightPx, world };
}

async function decodeRaw(y: StabilityYSlice): Promise<LoadedStabilityRaw> {
    const url = sliceUrl(y, true);
    if (!url) throw new Error(R2_REQUIRED);
    // Decode straight from PNG bytes (never via canvas) so anti-fingerprinting
    // browsers can't randomize the readback — same rationale as the climate
    // loader. NOTE: these rasters are 8000×8000 (~256 MB RGBA), so only the
    // active slice's raw is ever decoded and it's cached one-at-a-time.
    const buffer = await fetch(url).then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch stability raw PNG (${r.status})`);
        return r.arrayBuffer();
    });
    const decoded = await decodePng(buffer);
    return {
        y,
        rgba: decoded.rgba,
        width: decoded.width,
        height: decoded.height,
        world: WORLDS[y],
        decode: decodeStability,
    };
}

export function loadStabilityColor(y: StabilityYSlice): Promise<LoadedStabilityColor> {
    let p = colorCache.get(y);
    if (!p) {
        p = Promise.resolve().then(() => resolveColor(y));
        colorCache.set(y, p);
    }
    return p;
}

export function loadStabilityRaw(y: StabilityYSlice): Promise<LoadedStabilityRaw> {
    let p = rawCache.get(y);
    if (!p) {
        p = decodeRaw(y);
        rawCache.set(y, p);
    }
    return p;
}

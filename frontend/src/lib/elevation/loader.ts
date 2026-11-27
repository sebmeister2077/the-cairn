// Runtime loader for the terrain elevation rasters (Rapids Exporter height
// map, downsampled by tools/prepare-rapids-export/prepare_rapids_export.py).
//
// Like the temporal-stability slices, the rasters themselves are NOT committed:
// they live in the public R2 bucket under `elevation/<basename>/`. Only the
// tiny `*.world.json` georef files stay bundled (needed synchronously for the
// overlay bounds). During `vite dev`, rasters present locally under
// `src/assets/Elevation/` (i.e. right after running the prepare script) are
// served directly, so the overlay works before the R2 upload.
//
// Cache-busting: the timestamped base name is part of every URL. To refresh,
// re-run the prepare script, upload the two rasters, and update the base name
// + the two world.json imports below.

import colorWorldJson from "@/assets/Elevation/heightmap_20261127_005609/heightmap_20261127_005609.world.json";
import rawWorldJson from "@/assets/Elevation/heightmap_20261127_005609/heightmap_20261127_005609.h8.world.json";

import { decodePng } from "../tops-map-view/png";
import type { ElevationWorld, LoadedElevationRaw } from "./types";

/** Timestamped export folder name; also the R2 path segment + cache-buster. */
export const ELEVATION_BASE_NAME = "heightmap_20261127_005609";

const COLOR_FILE = `${ELEVATION_BASE_NAME}.webp`;
const RAW_FILE = `${ELEVATION_BASE_NAME}.h8.png`;

const publicBucketOrigin = import.meta.env.VITE_PUBLIC_BUCKET_ORIGIN?.replace(/\/+$/, "");

// Dev-only local copies. The lazy glob sits behind `import.meta.env.DEV`, so
// production builds drop it entirely and never bundle the rasters.
const LOCAL_RASTERS: Record<string, () => Promise<unknown>> = import.meta.env.DEV
    ? import.meta.glob("/src/assets/Elevation/*/*.{webp,png}", { query: "?url", import: "default" })
    : {};

const COLOR_WORLD = colorWorldJson as ElevationWorld;
const RAW_WORLD = rawWorldJson as ElevationWorld;

const R2_REQUIRED = "Elevation rasters are hosted on R2; set VITE_PUBLIC_BUCKET_ORIGIN.";

async function rasterUrl(file: string): Promise<string> {
    const local = LOCAL_RASTERS[`/src/assets/Elevation/${ELEVATION_BASE_NAME}/${file}`];
    if (local) return (await local()) as string;
    if (!publicBucketOrigin) throw new Error(R2_REQUIRED);
    return `${publicBucketOrigin}/elevation/${ELEVATION_BASE_NAME}/${file}`;
}

/** Georef of the colour (relief) raster. */
export function getElevationWorld(): ElevationWorld {
    return COLOR_WORLD;
}

/** Georef of the raw height raster used for hover + band mode. */
export function getElevationRawWorld(): ElevationWorld {
    return RAW_WORLD;
}

let colorUrlPromise: Promise<string> | null = null;
let rawPromise: Promise<LoadedElevationRaw> | null = null;

/** URL of the shaded-relief raster (rendered directly by an `<img>`). */
export function loadElevationColorUrl(): Promise<string> {
    if (!colorUrlPromise) {
        colorUrlPromise = rasterUrl(COLOR_FILE).catch((err: unknown) => {
            colorUrlPromise = null;
            throw err;
        });
    }
    return colorUrlPromise;
}

/**
 * Decode the 8-bit raw height raster (2000 px ≈ 16 MB RGBA). Decoded straight
 * from PNG bytes, never via a canvas, so anti-fingerprinting browsers can't
 * randomize the readback (same rationale as the climate loader).
 */
export function loadElevationRaw(): Promise<LoadedElevationRaw> {
    if (!rawPromise) {
        rawPromise = (async () => {
            const url = await rasterUrl(RAW_FILE);
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Failed to fetch elevation raw PNG (${res.status})`);
            const decoded = await decodePng(await res.arrayBuffer());
            return {
                rgba: decoded.rgba,
                width: decoded.width,
                height: decoded.height,
                world: RAW_WORLD,
            };
        })().catch((err: unknown) => {
            rawPromise = null;
            throw err;
        });
    }
    return rawPromise;
}

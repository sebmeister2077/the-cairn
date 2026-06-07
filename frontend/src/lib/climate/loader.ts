import climateRootJson from "@/assets/Climate/climate_20260608_001141/climate_20260608_001141.json";

import tempavgPngUrl from "@/assets/Climate/climate_20260608_001141/climate_20260608_001141.tempavg.png?url";
import tempavgRawPngUrl from "@/assets/Climate/climate_20260608_001141/climate_20260608_001141.tempavg.raw.png?url";
import tempavgWorldJson from "@/assets/Climate/climate_20260608_001141/climate_20260608_001141.tempavg.world.json";

import tempminPngUrl from "@/assets/Climate/climate_20260608_001141/climate_20260608_001141.tempmin.png?url";
import tempminRawPngUrl from "@/assets/Climate/climate_20260608_001141/climate_20260608_001141.tempmin.raw.png?url";
import tempminWorldJson from "@/assets/Climate/climate_20260608_001141/climate_20260608_001141.tempmin.world.json";

import tempmaxPngUrl from "@/assets/Climate/climate_20260608_001141/climate_20260608_001141.tempmax.png?url";
import tempmaxRawPngUrl from "@/assets/Climate/climate_20260608_001141/climate_20260608_001141.tempmax.raw.png?url";
import tempmaxWorldJson from "@/assets/Climate/climate_20260608_001141/climate_20260608_001141.tempmax.world.json";

import rainfallPngUrl from "@/assets/Climate/climate_20260608_001141/climate_20260608_001141.rainfall.png?url";
import rainfallRawPngUrl from "@/assets/Climate/climate_20260608_001141/climate_20260608_001141.rainfall.raw.png?url";
import rainfallWorldJson from "@/assets/Climate/climate_20260608_001141/climate_20260608_001141.rainfall.world.json";

import geoactivityPngUrl from "@/assets/Climate/climate_20260608_001141/climate_20260608_001141.geoactivity.png?url";
import geoactivityRawPngUrl from "@/assets/Climate/climate_20260608_001141/climate_20260608_001141.geoactivity.raw.png?url";
import geoactivityWorldJson from "@/assets/Climate/climate_20260608_001141/climate_20260608_001141.geoactivity.world.json";

import { decodeKindFor, decoderFor } from "./decode";
import type {
    ClimateLayerKind,
    ClimateLayerMeta,
    ClimateRootMeta,
    ClimateWorld,
    LoadedClimateColor,
    LoadedClimatePercentiles,
    LoadedClimateRaw,
} from "./types";

interface BundledClimateLayer {
    pngUrl: string;
    rawPngUrl: string;
    world: ClimateWorld;
}

const BUNDLED: Record<ClimateLayerKind, BundledClimateLayer> = {
    tempavg: {
        pngUrl: tempavgPngUrl,
        rawPngUrl: tempavgRawPngUrl,
        world: tempavgWorldJson as ClimateWorld,
    },
    tempmin: {
        pngUrl: tempminPngUrl,
        rawPngUrl: tempminRawPngUrl,
        world: tempminWorldJson as ClimateWorld,
    },
    tempmax: {
        pngUrl: tempmaxPngUrl,
        rawPngUrl: tempmaxRawPngUrl,
        world: tempmaxWorldJson as ClimateWorld,
    },
    rainfall: {
        pngUrl: rainfallPngUrl,
        rawPngUrl: rainfallRawPngUrl,
        world: rainfallWorldJson as ClimateWorld,
    },
    geoactivity: {
        pngUrl: geoactivityPngUrl,
        rawPngUrl: geoactivityRawPngUrl,
        world: geoactivityWorldJson as ClimateWorld,
    },
};

const ROOT_META: ClimateRootMeta = climateRootJson as ClimateRootMeta;

export function getClimateRootMeta(): ClimateRootMeta {
    return ROOT_META;
}

export function getClimateLayerMeta(kind: ClimateLayerKind): ClimateLayerMeta | null {
    return ROOT_META.layers.find((l) => l.layer === kind) ?? null;
}

export function getClimateWorld(kind: ClimateLayerKind): ClimateWorld {
    return BUNDLED[kind].world;
}

const colorCache = new Map<ClimateLayerKind, Promise<LoadedClimateColor>>();
const rawCache = new Map<ClimateLayerKind, Promise<LoadedClimateRaw>>();

async function decodeColor(
    triplet: BundledClimateLayer,
    kind: ClimateLayerKind,
): Promise<LoadedClimateColor> {
    // For plain (no-threshold) modes we don't need pixel data — the
    // browser can render the bundled `?url` import directly. We still
    // need natural width/height for cursor-probe / fallback paths.
    return {
        kind,
        url: triplet.pngUrl,
        width: triplet.world.widthPx,
        height: triplet.world.heightPx,
        world: triplet.world,
    };
}

async function decodeRaw(
    triplet: BundledClimateLayer,
    kind: ClimateLayerKind,
): Promise<LoadedClimateRaw> {
    const blob = await fetch(triplet.rawPngUrl).then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch climate raw PNG (${r.status})`);
        return r.blob();
    });
    const bitmap = await createImageBitmap(blob);
    const w = bitmap.width;
    const h = bitmap.height;
    const useOffscreen = typeof OffscreenCanvas !== "undefined";
    const canvas = useOffscreen
        ? new OffscreenCanvas(w, h)
        : (() => {
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            return c;
        })();
    const ctx = (canvas as OffscreenCanvas | HTMLCanvasElement).getContext("2d") as
        | OffscreenCanvasRenderingContext2D
        | CanvasRenderingContext2D
        | null;
    if (!ctx) throw new Error("Could not acquire 2D context for climate raw PNG");
    ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0);
    const imageData = (ctx as CanvasRenderingContext2D).getImageData(0, 0, w, h);
    bitmap.close?.();

    const decode = decoderFor(kind);
    const decodeKind = decodeKindFor(kind);
    const percentiles = computePercentiles(imageData.data, decode, decodeKind);

    return {
        kind,
        rgba: imageData.data,
        width: w,
        height: h,
        world: triplet.world,
        decodeKind,
        decode,
        percentiles,
    };
}

/** Compute p1/p50/p99 of the pixel distribution via a 4096-bin histogram.
 *  Used to anchor a contrast-stretched gradient for skewed unit-range
 *  layers (e.g. geoactivity, where avg ~0.05 but max = 1.0). */
function computePercentiles(
    rgba: Uint8ClampedArray,
    decode: (r: number, g: number) => number,
    decodeKind: "temp" | "unit",
): LoadedClimatePercentiles {
    // Pick a fixed value range per decode kind so histogram bins map
    // predictably regardless of the per-image data range.
    const lo = decodeKind === "temp" ? -100 : 0;
    const hi = decodeKind === "temp" ? 100 : 1;
    const span = hi - lo;
    const bins = 4096;
    const hist = new Uint32Array(bins);
    const totalPixels = (rgba.length / 4) | 0;
    let counted = 0;
    for (let i = 0; i < totalPixels; i++) {
        const o = i * 4;
        const v = decode(rgba[o], rgba[o + 1]);
        const t = (v - lo) / span;
        if (t < 0 || t > 1) continue;
        const b = Math.min(bins - 1, Math.floor(t * bins));
        hist[b]++;
        counted++;
    }
    if (counted === 0) {
        return { p1: lo, p50: (lo + hi) / 2, p99: hi };
    }
    const target1 = counted * 0.01;
    const target50 = counted * 0.5;
    const target99 = counted * 0.99;
    let cum = 0;
    let p1 = lo;
    let p50 = (lo + hi) / 2;
    let p99 = hi;
    let foundP1 = false;
    let foundP50 = false;
    for (let i = 0; i < bins; i++) {
        cum += hist[i];
        const value = lo + ((i + 0.5) / bins) * span;
        if (!foundP1 && cum >= target1) {
            p1 = value;
            foundP1 = true;
        }
        if (!foundP50 && cum >= target50) {
            p50 = value;
            foundP50 = true;
        }
        if (cum >= target99) {
            p99 = value;
            break;
        }
    }
    return { p1, p50, p99 };
}

export function loadClimateColor(kind: ClimateLayerKind): Promise<LoadedClimateColor> {
    let p = colorCache.get(kind);
    if (!p) {
        p = decodeColor(BUNDLED[kind], kind);
        colorCache.set(kind, p);
    }
    return p;
}

export function loadClimateRaw(kind: ClimateLayerKind): Promise<LoadedClimateRaw> {
    let p = rawCache.get(kind);
    if (!p) {
        p = decodeRaw(BUNDLED[kind], kind);
        rawCache.set(kind, p);
    }
    return p;
}

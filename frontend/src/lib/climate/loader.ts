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

    return {
        kind,
        rgba: imageData.data,
        width: w,
        height: h,
        world: triplet.world,
        decodeKind: decodeKindFor(kind),
        decode: decoderFor(kind),
    };
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

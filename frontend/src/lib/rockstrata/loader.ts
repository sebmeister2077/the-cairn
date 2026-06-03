import rockmapPngUrl from "@/assets/RockStrata/rockmap_20260603_194847.png?url";
import rockmapMetaJson from "@/assets/RockStrata/rockmap_20260603_194847.json";
import rockmapWorldJson from "@/assets/RockStrata/rockmap_20260603_194847.world.json";

import type {
    LoadedRockMap,
    RockMapMeta,
    RockMapWorld,
    RockStrataLayerKind,
} from "./types";

interface BundledTriplet {
    pngUrl: string;
    meta: RockMapMeta;
    world: RockMapWorld;
}

const BUNDLED: Partial<Record<RockStrataLayerKind, BundledTriplet>> = {
    rock: {
        pngUrl: rockmapPngUrl,
        meta: rockmapMetaJson as RockMapMeta,
        world: rockmapWorldJson as RockMapWorld,
    },
    // geo: not currently shipped — UI hides the radio when undefined.
};

export function isLayerAvailable(kind: RockStrataLayerKind): boolean {
    return BUNDLED[kind] != null;
}

export function getLayerLegend(kind: RockStrataLayerKind) {
    return BUNDLED[kind]?.meta.legend ?? null;
}

const cache = new Map<RockStrataLayerKind, Promise<LoadedRockMap>>();

async function decode(triplet: BundledTriplet, kind: RockStrataLayerKind): Promise<LoadedRockMap> {
    const blob = await fetch(triplet.pngUrl).then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch rockstrata PNG (${r.status})`);
        return r.blob();
    });
    const bitmap = await createImageBitmap(blob);
    const w = bitmap.width;
    const h = bitmap.height;
    const canvas =
        typeof OffscreenCanvas !== "undefined"
            ? new OffscreenCanvas(w, h)
            : (() => {
                const c = document.createElement("canvas");
                c.width = w;
                c.height = h;
                return c;
            })();
    const ctx = (canvas as OffscreenCanvas).getContext("2d") as
        | OffscreenCanvasRenderingContext2D
        | CanvasRenderingContext2D
        | null;
    if (!ctx) throw new Error("Could not acquire 2D context for rockstrata PNG");
    ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0);
    const imageData = (ctx as CanvasRenderingContext2D).getImageData(0, 0, w, h);
    bitmap.close?.();

    // Detect duplicate hexcolors across legend entries — the mod hashes
    // unknown blocks to a color, so two distinct codes can collide and
    // become indistinguishable in the keep-set filter. Surface this once
    // at load time so it's debuggable from the console.
    const seen = new Map<string, string>();
    for (const e of triplet.meta.legend) {
        const key = e.hexcolor.toUpperCase();
        const prev = seen.get(key);
        if (prev) {
            console.warn(
                `[rockstrata] duplicate hexcolor ${key} for codes "${prev}" and "${e.code}" — filter cannot distinguish them.`,
            );
        } else {
            seen.set(key, e.code);
        }
    }

    return {
        layerKind: kind,
        rgba: imageData.data,
        width: w,
        height: h,
        meta: triplet.meta,
        world: triplet.world,
        legend: triplet.meta.legend,
    };
}

export function loadRockMap(kind: RockStrataLayerKind): Promise<LoadedRockMap> | null {
    const triplet = BUNDLED[kind];
    if (!triplet) return null;
    let p = cache.get(kind);
    if (!p) {
        p = decode(triplet, kind);
        cache.set(kind, p);
    }
    return p;
}

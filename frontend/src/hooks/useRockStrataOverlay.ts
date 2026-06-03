import { useEffect, useMemo, useRef, useState } from "react";
import RockStrataFilterWorker from "@/workers/rockstrata-filter.worker.ts?worker";
import type { FilterRequest, FilterResponse } from "@/workers/rockstrata-filter.worker";
import { loadRockMap } from "@/lib/rockstrata/loader";
import { cropAroundCenter, encodeRgbaToPngUrl } from "@/lib/rockstrata/crop";
import type {
    LegendEntry,
    LoadedRockMap,
    RockStrataLayerKind,
} from "@/lib/rockstrata/types";

export interface RockStrataOverlayBounds {
    /** World-block top-left of the overlay rectangle. */
    originX: number;
    originZ: number;
    /** World-block extent of the overlay rectangle. */
    extentX: number;
    extentZ: number;
}

export interface UseRockStrataOverlayParams {
    enabled: boolean;
    layerKind: RockStrataLayerKind;
    /** When `null`, all legend codes are kept. */
    keepCodes: string[] | null;
    /** Window half-size in world blocks. Caller should clamp to ≤12000. */
    halfBlocks: number;
    /** Center of the requested viewing window. When null, falls back to
     *  `meta.center` from the loaded export. */
    center: { x: number; z: number } | null;
    /** Pan-debounce window in ms. Default 250 (per spec). */
    debounceMs?: number;
}

export interface UseRockStrataOverlayResult {
    status: "idle" | "loading" | "ready" | "error";
    error: string | null;
    overlayUrl: string | null;
    overlayBounds: RockStrataOverlayBounds | null;
    legend: LegendEntry[] | null;
    /** Max of source `blocksPerPixelX/Z`. UI uses this for the >10 warning. */
    sourceBlocksPerPixel: number | null;
    /** Whether the source export is too coarse for the requested window. */
    warnBlocky: boolean;
}

/** Spec hard cap. */
const HALF_BLOCKS_MAX = 12000;

let workerSingleton: Worker | null = null;
function getWorker(): Worker {
    if (!workerSingleton) {
        workerSingleton = new RockStrataFilterWorker();
    }
    return workerSingleton;
}

let nextRequestId = 1;

function runFilter(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
    keepHex: string[],
    abortFlag: { aborted: boolean },
): Promise<Uint8ClampedArray> {
    const requestId = nextRequestId++;
    // The source RGBA is shared across renders; transferring it to the
    // worker would detach it. Hand the worker a disposable clone.
    const copy = new Uint8ClampedArray(rgba);
    const worker = getWorker();

    return new Promise<Uint8ClampedArray>((resolve, reject) => {
        function onMessage(ev: MessageEvent<FilterResponse>) {
            if (ev.data.requestId !== requestId) return;
            worker.removeEventListener("message", onMessage);
            if (abortFlag.aborted) {
                reject(new Error("aborted"));
                return;
            }
            resolve(new Uint8ClampedArray(ev.data.rgba));
        }
        worker.addEventListener("message", onMessage);

        const req: FilterRequest = { requestId, rgba: copy.buffer, width, height, keepHex };
        worker.postMessage(req, [copy.buffer]);
    });
}

export function useRockStrataOverlay({
    enabled,
    layerKind,
    keepCodes,
    halfBlocks,
    center,
    debounceMs = 250,
}: UseRockStrataOverlayParams): UseRockStrataOverlayResult {
    const [loaded, setLoaded] = useState<LoadedRockMap | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<UseRockStrataOverlayResult["status"]>("idle");
    const [overlayUrl, setOverlayUrl] = useState<string | null>(null);
    const [overlayBounds, setOverlayBounds] = useState<RockStrataOverlayBounds | null>(null);

    const lastUrlRef = useRef<string | null>(null);

    // Lazy-load the source raster. Runs once per `layerKind`.
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setError(null);
        setStatus((s) => (s === "ready" ? s : "loading"));
        const p = loadRockMap(layerKind);
        if (!p) {
            setError(`Layer "${layerKind}" not bundled`);
            setStatus("error");
            return;
        }
        p.then((m) => {
            if (cancelled) return;
            setLoaded(m);
        }).catch((e: unknown) => {
            if (cancelled) return;
            setError(e instanceof Error ? e.message : String(e));
            setStatus("error");
        });
        return () => {
            cancelled = true;
        };
    }, [enabled, layerKind]);

    // Memoize the keep-hex set. When `keepCodes` is null, all colors pass.
    const keepHex = useMemo(() => {
        if (!loaded) return null;
        if (keepCodes == null) return loaded.legend.map((e) => e.hexcolor.toUpperCase());
        const allow = new Set(keepCodes);
        return loaded.legend
            .filter((e) => allow.has(e.code))
            .map((e) => e.hexcolor.toUpperCase());
    }, [loaded, keepCodes]);

    // Centre defaults to the export's metadata centre.
    const effectiveCenter = useMemo(() => {
        if (center) return center;
        return loaded ? loaded.meta.center : null;
    }, [center, loaded]);

    const clampedHalf = Math.max(1, Math.min(HALF_BLOCKS_MAX, Math.round(halfBlocks)));

    // Debounce regeneration on `effectiveCenter` + `clampedHalf` so panning
    // produces at most one filter+crop per ~debounceMs idle.
    const [debouncedTrigger, setDebouncedTrigger] = useState({
        cx: effectiveCenter?.x ?? 0,
        cz: effectiveCenter?.z ?? 0,
        half: clampedHalf,
    });
    useEffect(() => {
        if (!effectiveCenter) return;
        const handle = window.setTimeout(() => {
            setDebouncedTrigger({
                cx: effectiveCenter.x,
                cz: effectiveCenter.z,
                half: clampedHalf,
            });
        }, debounceMs);
        return () => window.clearTimeout(handle);
    }, [effectiveCenter, clampedHalf, debounceMs]);

    // Re-run filter+crop whenever inputs change.
    useEffect(() => {
        if (!enabled || !loaded || !keepHex || !effectiveCenter) return;

        const abortFlag = { aborted: false };
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setStatus("loading");

        runFilter(loaded.rgba, loaded.width, loaded.height, keepHex, abortFlag)
            .then((filtered) => {
                if (abortFlag.aborted) return null;
                const crop = cropAroundCenter(
                    filtered,
                    loaded.width,
                    loaded.height,
                    loaded.world,
                    debouncedTrigger.cx,
                    debouncedTrigger.cz,
                    debouncedTrigger.half,
                );
                return encodeRgbaToPngUrl(crop.rgba, crop.width, crop.height).then((url) => ({
                    url,
                    bounds: {
                        originX: crop.originBlockX,
                        originZ: crop.originBlockZ,
                        extentX: crop.extentBlocksX,
                        extentZ: crop.extentBlocksZ,
                    },
                }));
            })
            .then((result) => {
                if (!result || abortFlag.aborted) return;
                if (lastUrlRef.current) URL.revokeObjectURL(lastUrlRef.current);
                lastUrlRef.current = result.url;
                setOverlayUrl(result.url);
                setOverlayBounds(result.bounds);
                setStatus("ready");
            })
            .catch((e: unknown) => {
                if (abortFlag.aborted) return;
                setError(e instanceof Error ? e.message : String(e));
                setStatus("error");
            });

        return () => {
            abortFlag.aborted = true;
        };
        // debouncedTrigger already encodes the latest effectiveCenter; including it would re-run before the debounce settles.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, loaded, keepHex, debouncedTrigger]);

    // Revoke the last URL on unmount.
    useEffect(() => {
        return () => {
            if (lastUrlRef.current) {
                URL.revokeObjectURL(lastUrlRef.current);
                lastUrlRef.current = null;
            }
        };
    }, []);

    const sourceBlocksPerPixel = loaded
        ? Math.max(loaded.world.blocksPerPixelX, loaded.world.blocksPerPixelZ)
        : null;

    return {
        status,
        error,
        overlayUrl: enabled ? overlayUrl : null,
        overlayBounds: enabled ? overlayBounds : null,
        legend: loaded ? loaded.legend : null,
        sourceBlocksPerPixel,
        warnBlocky: sourceBlocksPerPixel != null && sourceBlocksPerPixel > 10,
    };
}

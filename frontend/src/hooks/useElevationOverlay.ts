import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ThresholdWorker from "@/workers/climate-threshold.worker.ts?worker";
import type { ThresholdRequest, ThresholdResponse } from "@/workers/climate-threshold.worker";
import { encodeRgbaToPngUrl } from "@/lib/rockstrata/crop";
import {
    getElevationWorld,
    loadElevationColorUrl,
    loadElevationRaw,
} from "@/lib/elevation/loader";
import type {
    ElevationMode,
    ElevationOverlayBounds,
    ElevationSample,
    LoadedElevationRaw,
} from "@/lib/elevation/types";

/** The elevation `world.json` uses absolute block coords (origin 412 000,
 *  centre 512 000); the viewer renders centred TOPS coords. Same shift as the
 *  climate/stability overlays, so all rasters line up. */
const ELEVATION_WORLD_CENTER_OFFSET = 512_000;

/** In-band tint (pink-500): distinct from the teal/orange rapids markers. */
const BAND_TINT: [number, number, number] = [236, 72, 153];
/** Alpha of the dim veil over out-of-band terrain (0..255). */
const BAND_OUTSIDE_ALPHA = 110;

export interface UseElevationOverlayParams {
    enabled: boolean;
    mode: ElevationMode;
    bandMin: number;
    bandMax: number;
    debounceMs?: number;
}

export interface UseElevationOverlayResult {
    status: "idle" | "loading" | "ready" | "error";
    error: string | null;
    overlayUrl: string | null;
    overlayBounds: ElevationOverlayBounds | null;
    /** Terrain height under a centred world coordinate, or null when the raw
     *  raster isn't decoded yet or the point is outside it. */
    sampleAt: (worldX: number, worldZ: number) => ElevationSample | null;
    /** Flips true once the raw raster is decoded, so readouts re-sample. */
    rawReady: boolean;
}

let workerSingleton: Worker | null = null;
let nextRequestId = 1;

function runBandMask(
    raw: LoadedElevationRaw,
    lo: number,
    hi: number,
    abortFlag: { aborted: boolean },
): Promise<Uint8ClampedArray> {
    if (!workerSingleton) workerSingleton = new ThresholdWorker();
    const worker = workerSingleton;
    const requestId = nextRequestId++;
    return new Promise((resolve, reject) => {
        function onMessage(ev: MessageEvent<ThresholdResponse>) {
            if (ev.data.requestId !== requestId) return;
            worker.removeEventListener("message", onMessage);
            if (abortFlag.aborted) {
                reject(new Error("aborted"));
                return;
            }
            resolve(new Uint8ClampedArray(ev.data.rgba));
        }
        worker.addEventListener("message", onMessage);
        // Transfer a copy: the cached raw must stay intact for later re-runs.
        const copy = new Uint8ClampedArray(raw.rgba);
        const req: ThresholdRequest = {
            requestId,
            rawBuffer: copy.buffer,
            width: raw.width,
            height: raw.height,
            decode: "height",
            op: { kind: "custom", lo, hi },
            tintColor: BAND_TINT,
            outsideAlpha: BAND_OUTSIDE_ALPHA,
        };
        worker.postMessage(req, [copy.buffer]);
    });
}

export function useElevationOverlay({
    enabled,
    mode,
    bandMin,
    bandMax,
    debounceMs = 200,
}: UseElevationOverlayParams): UseElevationOverlayResult {
    const [overlayUrl, setOverlayUrl] = useState<string | null>(null);
    const [status, setStatus] = useState<UseElevationOverlayResult["status"]>("idle");
    const [error, setError] = useState<string | null>(null);
    const [rawReady, setRawReady] = useState(false);
    const rawRef = useRef<LoadedElevationRaw | null>(null);
    /** Blob URL of the last band mask, revoked when replaced. */
    const lastDerivedUrlRef = useRef<string | null>(null);

    const overlayBounds = useMemo<ElevationOverlayBounds | null>(() => {
        if (!enabled) return null;
        const w = getElevationWorld();
        return {
            originX: w.originBlockX - ELEVATION_WORLD_CENTER_OFFSET,
            originZ: w.originBlockZ - ELEVATION_WORLD_CENTER_OFFSET,
            extentX: w.widthPx * w.blocksPerPixelX,
            extentZ: w.heightPx * w.blocksPerPixelZ,
        };
    }, [enabled]);

    // Debounce band re-masks so dragging a slider doesn't re-encode per frame.
    const [band, setBand] = useState({ lo: bandMin, hi: bandMax });
    useEffect(() => {
        const handle = window.setTimeout(() => setBand({ lo: bandMin, hi: bandMax }), debounceMs);
        return () => window.clearTimeout(handle);
    }, [bandMin, bandMax, debounceMs]);
    // Relief mode ignores the band, so band edits there don't re-run the overlay.
    const activeBand = mode === "band" ? band : null;

    // Raw heights back the hover readout in both modes and the band mask.
    useEffect(() => {
        if (!enabled) return;
        let aborted = false;
        loadElevationRaw()
            .then((raw) => {
                if (aborted) return;
                rawRef.current = raw;
                setRawReady(true);
            })
            .catch(() => {
                // Surfaced by the overlay effect below when it matters.
            });
        return () => {
            aborted = true;
        };
    }, [enabled]);

    useEffect(() => {
        if (!enabled) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setOverlayUrl(null);
            setStatus("idle");
            setError(null);
            return;
        }
        const abortFlag = { aborted: false };
        setStatus("loading");
        setError(null);

        const fail = (e: unknown) => {
            if (abortFlag.aborted) return;
            if (e instanceof Error && e.message === "aborted") return;
            setError(e instanceof Error ? e.message : String(e));
            setStatus("error");
        };

        if (mode === "relief") {
            loadElevationColorUrl()
                .then((url) => {
                    if (abortFlag.aborted) return;
                    setOverlayUrl(url);
                    setStatus("ready");
                    if (lastDerivedUrlRef.current) {
                        URL.revokeObjectURL(lastDerivedUrlRef.current);
                        lastDerivedUrlRef.current = null;
                    }
                })
                .catch(fail);
        } else if (activeBand) {
            loadElevationRaw()
                .then((raw) =>
                    runBandMask(raw, activeBand.lo, activeBand.hi, abortFlag).then((rgba) =>
                        encodeRgbaToPngUrl(rgba, raw.width, raw.height),
                    ),
                )
                .then((url) => {
                    if (abortFlag.aborted) {
                        URL.revokeObjectURL(url);
                        return;
                    }
                    if (lastDerivedUrlRef.current) URL.revokeObjectURL(lastDerivedUrlRef.current);
                    lastDerivedUrlRef.current = url;
                    setOverlayUrl(url);
                    setStatus("ready");
                })
                .catch(fail);
        }
        return () => {
            abortFlag.aborted = true;
        };
    }, [enabled, mode, activeBand]);

    useEffect(() => {
        return () => {
            if (lastDerivedUrlRef.current) {
                URL.revokeObjectURL(lastDerivedUrlRef.current);
                lastDerivedUrlRef.current = null;
            }
        };
    }, []);

    const sampleAt = useCallback((worldX: number, worldZ: number): ElevationSample | null => {
        const raw = rawRef.current;
        if (!raw) return null;
        const w = raw.world;
        const absX = worldX + ELEVATION_WORLD_CENTER_OFFSET;
        const absZ = worldZ + ELEVATION_WORLD_CENTER_OFFSET;
        const px = Math.floor((absX - w.originBlockX) / w.blocksPerPixelX);
        const pz = Math.floor((absZ - w.originBlockZ) / w.blocksPerPixelZ);
        if (px < 0 || pz < 0 || px >= raw.width || pz >= raw.height) return null;
        const y = raw.rgba[(pz * raw.width + px) * 4];
        const waterSurface = w.seaLevel - 1;
        const isWater = y < waterSurface;
        return {
            y,
            isWater,
            depth: isWater ? waterSurface - y : 0,
            aboveSea: y - waterSurface,
            resolutionBlocks: Math.round(w.blocksPerPixelX),
        };
    }, []);

    return {
        status,
        error,
        overlayUrl: enabled ? overlayUrl : null,
        overlayBounds,
        sampleAt,
        rawReady,
    };
}

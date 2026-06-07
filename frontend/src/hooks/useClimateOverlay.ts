import { useEffect, useMemo, useRef, useState } from "react";
import ClimateThresholdWorker from "@/workers/climate-threshold.worker.ts?worker";
import type {
    ThresholdOp,
    ThresholdRequest,
    ThresholdResponse,
} from "@/workers/climate-threshold.worker";
import { encodeRgbaToPngUrl } from "@/lib/rockstrata/crop";
import {
    getClimateLayerMeta,
    getClimateWorld,
    loadClimateColor,
    loadClimateRaw,
} from "@/lib/climate/loader";
import type {
    ClimateLayerKind,
    ClimateLayerMeta,
    ClimateOverlayBounds,
    ClimateSubToggle,
    ClimateTempVariant,
    ClimateThresholdMode,
    CropId,
    CropTolerance,
} from "@/lib/climate/types";
import { CROPS } from "@/lib/climate/types";

/** WC world center in absolute climate raster coords. The bundled
 *  raster's `world.json` uses absolute coords (origin = 412 000), but
 *  the viewer renders in centered TOPS coords (spawn ≈ 0,0). All
 *  translation between the two coord systems happens at this hook's
 *  boundary so callers can stay in centered space. */
const CLIMATE_WORLD_CENTER_OFFSET = 512_000;

export interface UseClimateOverlayParams {
    enabled: boolean;
    subToggle: ClimateSubToggle;
    tempVariant: ClimateTempVariant;
    thresholdMode: ClimateThresholdMode;
    /** Selected crop id when `thresholdMode === "crop"`. */
    cropId: CropId | null;
    /** Custom-mode lower bound on the active layer's units (°C or 0..1). */
    customMin: number | null;
    /** Custom-mode upper bound on the active layer's units. */
    customMax: number | null;
    /** Debounce window for threshold re-renders (ms). Default 200. */
    debounceMs?: number;
}

export interface UseClimateOverlayResult {
    status: "idle" | "loading" | "ready" | "error";
    error: string | null;
    overlayUrl: string | null;
    overlayBounds: ClimateOverlayBounds | null;
    /** The effective layer kind being rendered (after subToggle + tempVariant). */
    activeKind: ClimateLayerKind | null;
    /** Per-layer color anchors + stats from the root JSON. */
    layerMeta: ClimateLayerMeta | null;
    /** Whether the current view is a worker-derived (masked) PNG vs. the
     *  bundled color asset. UI uses this to know if the legend should be
     *  rendered as a tinted swatch instead of the original gradient. */
    isMasked: boolean;
}

function resolveActiveKind(
    subToggle: ClimateSubToggle,
    tempVariant: ClimateTempVariant,
): ClimateLayerKind | null {
    if (subToggle === "off") return null;
    if (subToggle === "rainfall") return "rainfall";
    if (subToggle === "geoactivity") return "geoactivity";
    return tempVariant;
}

function findCrop(id: CropId | null): CropTolerance | null {
    if (!id) return null;
    return CROPS.find((c) => c.id === id) ?? null;
}

/** Translate a UI threshold mode into a worker op. Crop mode is
 *  variant-independent: the dual-layer mask always operates on tempmin +
 *  tempmax, so the user can browse the avg/min/max gradient legend
 *  without disturbing the active crop selection. */
function resolveOp(
    mode: ClimateThresholdMode,
    cropId: CropId | null,
    customMin: number | null,
    customMax: number | null,
): ThresholdOp | null {
    if (mode === "none") return null;
    if (mode === "crop") {
        const crop = findCrop(cropId);
        if (!crop) return null;
        return {
            kind: "crop_band",
            minThreshold: crop.minTempC,
            maxThreshold: crop.maxTempC,
        };
    }
    if (mode === "custom") {
        return { kind: "custom", lo: customMin, hi: customMax };
    }
    return null;
}

function tintColorForKind(kind: ClimateLayerKind): [number, number, number] {
    // Rich green for crop-friendly highlights on temperature layers.
    if (kind === "tempavg" || kind === "tempmin" || kind === "tempmax") return [80, 200, 120];
    if (kind === "rainfall") return [60, 130, 220];
    return [220, 160, 60];
}

let workerSingleton: Worker | null = null;
function getWorker(): Worker {
    if (!workerSingleton) workerSingleton = new ClimateThresholdWorker();
    return workerSingleton;
}

let nextRequestId = 1;

function runThreshold(
    rawBuffer: ArrayBuffer,
    width: number,
    height: number,
    decode: "temp" | "unit",
    op: ThresholdOp,
    tintColor: [number, number, number],
    outsideAlpha: number,
    abortFlag: { aborted: boolean },
    secondBuffer?: ArrayBuffer,
    secondDecode?: "temp" | "unit",
): Promise<Uint8ClampedArray> {
    const requestId = nextRequestId++;
    const worker = getWorker();
    return new Promise<Uint8ClampedArray>((resolve, reject) => {
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
        // Clone the raw buffer — the cached source must stay intact for
        // subsequent re-runs (e.g. dragging a custom slider).
        const copy = new Uint8ClampedArray(new Uint8ClampedArray(rawBuffer));
        const transfer: ArrayBuffer[] = [copy.buffer];
        let secondCopyBuffer: ArrayBuffer | undefined;
        if (secondBuffer) {
            const c2 = new Uint8ClampedArray(new Uint8ClampedArray(secondBuffer));
            secondCopyBuffer = c2.buffer;
            transfer.push(secondCopyBuffer);
        }
        const req: ThresholdRequest = {
            requestId,
            rawBuffer: copy.buffer,
            secondRawBuffer: secondCopyBuffer,
            width,
            height,
            decode,
            secondDecode,
            op,
            tintColor,
            outsideAlpha,
        };
        worker.postMessage(req, transfer);
    });
}

export function useClimateOverlay({
    enabled,
    subToggle,
    tempVariant,
    thresholdMode,
    cropId,
    customMin,
    customMax,
    debounceMs = 200,
}: UseClimateOverlayParams): UseClimateOverlayResult {
    const activeKind = enabled ? resolveActiveKind(subToggle, tempVariant) : null;

    const [overlayUrl, setOverlayUrl] = useState<string | null>(null);
    const [status, setStatus] = useState<UseClimateOverlayResult["status"]>("idle");
    const [error, setError] = useState<string | null>(null);
    const [isMasked, setIsMasked] = useState(false);

    /** Track URLs created via `URL.createObjectURL` so we can revoke them.
     *  Bundled `?url` imports are static and must not be revoked. */
    const lastDerivedUrlRef = useRef<string | null>(null);

    const layerMeta = useMemo(
        () => (activeKind ? getClimateLayerMeta(activeKind) : null),
        [activeKind],
    );

    const overlayBounds = useMemo<ClimateOverlayBounds | null>(() => {
        if (!activeKind) return null;
        const world = getClimateWorld(activeKind);
        return {
            originX: world.originBlockX - CLIMATE_WORLD_CENTER_OFFSET,
            originZ: world.originBlockZ - CLIMATE_WORLD_CENTER_OFFSET,
            extentX: world.widthPx * world.blocksPerPixelX,
            extentZ: world.heightPx * world.blocksPerPixelZ,
        };
    }, [activeKind]);

    const op = useMemo(
        () =>
            activeKind ? resolveOp(thresholdMode, cropId, customMin, customMax) : null,
        [activeKind, thresholdMode, cropId, customMin, customMax],
    );

    // Debounce custom-mode re-renders so dragging the dual slider doesn't
    // re-encode every frame. Pass-through (color asset) and discrete
    // presets don't need debouncing — they only change on toggle.
    const [debouncedOp, setDebouncedOp] = useState<ThresholdOp | null>(op);
    useEffect(() => {
        if (op?.kind !== "custom") {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setDebouncedOp(op);
            return;
        }
        const handle = window.setTimeout(() => setDebouncedOp(op), debounceMs);
        return () => window.clearTimeout(handle);
    }, [op, debounceMs]);

    // Resolve a URL for the overlay <img>: either the bundled color asset
    // (no threshold) or a worker-derived PNG (any threshold mode).
    useEffect(() => {
        if (!activeKind) {
            // Disable: clear UI state but keep cached source data warm
            // so re-toggling is instant.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setOverlayUrl(null);
            setStatus("idle");
            setError(null);
            setIsMasked(false);
            return;
        }

        const abortFlag = { aborted: false };
        setError(null);
        setStatus("loading");

        if (!debouncedOp) {
            // Plain mode — show the bundled colorized PNG directly.
            loadClimateColor(activeKind)
                .then((c) => {
                    if (abortFlag.aborted) return;
                    if (lastDerivedUrlRef.current) {
                        URL.revokeObjectURL(lastDerivedUrlRef.current);
                        lastDerivedUrlRef.current = null;
                    }
                    setOverlayUrl(c.url);
                    setIsMasked(false);
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
        }

        // Threshold mode — fetch raw RGBA, run worker, encode result.
        // crop_band always operates on tempmin + tempmax regardless of
        // which variant the user is currently browsing as the legend.
        const isCrop = debouncedOp.kind === "crop_band";
        const primary = loadClimateRaw(isCrop ? "tempmin" : activeKind);
        const secondary = isCrop ? loadClimateRaw("tempmax") : Promise.resolve(null);
        Promise.all([primary, secondary])
            .then(([raw, raw2]) =>
                runThreshold(
                    raw.rgba.buffer as ArrayBuffer,
                    raw.width,
                    raw.height,
                    raw.decodeKind,
                    debouncedOp,
                    tintColorForKind(activeKind),
                    96,
                    abortFlag,
                    raw2 ? (raw2.rgba.buffer as ArrayBuffer) : undefined,
                    raw2 ? raw2.decodeKind : undefined,
                ).then((rgba) =>
                    encodeRgbaToPngUrl(rgba, raw.width, raw.height).then((url) => ({ url })),
                ),
            )
            .then((result) => {
                if (abortFlag.aborted) return;
                if (lastDerivedUrlRef.current) URL.revokeObjectURL(lastDerivedUrlRef.current);
                lastDerivedUrlRef.current = result.url;
                setOverlayUrl(result.url);
                setIsMasked(true);
                setStatus("ready");
            })
            .catch((e: unknown) => {
                if (abortFlag.aborted) return;
                if (e instanceof Error && e.message === "aborted") return;
                setError(e instanceof Error ? e.message : String(e));
                setStatus("error");
            });

        return () => {
            abortFlag.aborted = true;
        };
    }, [activeKind, debouncedOp]);

    // Revoke the last derived URL on unmount.
    useEffect(() => {
        return () => {
            if (lastDerivedUrlRef.current) {
                URL.revokeObjectURL(lastDerivedUrlRef.current);
                lastDerivedUrlRef.current = null;
            }
        };
    }, []);

    return {
        status,
        error,
        overlayUrl: enabled ? overlayUrl : null,
        overlayBounds: enabled ? overlayBounds : null,
        activeKind,
        layerMeta,
        isMasked,
    };
}

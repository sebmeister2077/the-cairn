import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ClimateThresholdWorker from "@/workers/climate-threshold.worker.ts?worker";
import type {
    ColorStop,
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
    LoadedClimateRaw,
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

export interface ClimateSampleResult {
    /** The layer the user is currently looking at on the legend. */
    primary: { kind: ClimateLayerKind; value: number };
    /** Populated when crop mode is active so the readout can show both
     *  the cold-tolerance check and the heat-tolerance check side by side. */
    cropCheck?: {
        tempmin: number;
        tempmax: number;
        cropMin: number;
        cropMax: number;
        pass: boolean;
    };
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
    /** Sample the climate value at a centered (TOPS) world coordinate.
     *  Returns `null` until the relevant raw raster has finished
     *  decoding. Stable identity — safe to depend on. */
    sampleAt: (worldX: number, worldZ: number) => ClimateSampleResult | null;
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

function parseHex(hex: string): [number, number, number] {
    const h = hex.startsWith("#") ? hex.slice(1) : hex;
    const v = parseInt(h, 16);
    return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Build a piecewise-linear gradient using the layer's published color
 *  anchors but with the value axis affinely remapped from the layer's
 *  nominal range to the actual data percentile range `[p1, p99]`.
 *  Used for unit-range layers (rainfall, geoactivity) whose distribution
 *  is heavily skewed and whose bundled color PNG wastes most of the
 *  visible range on near-zero pixels. Temperature layers don't need this:
 *  their anchors are calibrated to specific real-world °C values. */
function buildStretchedStops(
    anchors: ReadonlyArray<{ value: number; hex: string }>,
    p1: number,
    p99: number,
): ColorStop[] {
    if (anchors.length === 0) return [];
    if (anchors.length === 1) return [{ value: p1, rgb: parseHex(anchors[0].hex) }];
    const v0 = anchors[0].value;
    const vN = anchors[anchors.length - 1].value;
    const span = vN - v0;
    const target = Math.max(1e-6, p99 - p1);
    const stops: ColorStop[] = anchors.map((a) => ({
        value: span > 0 ? p1 + ((a.value - v0) / span) * target : p1,
        rgb: parseHex(a.hex),
    }));
    return stops;
}

function needsAutoStretch(kind: ClimateLayerKind): boolean {
    return kind === "rainfall" || kind === "geoactivity";
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

    /** Refs used by `sampleAt` for synchronous cursor probe lookups. The
     *  effect below populates these as raw rasters finish decoding. We
     *  use refs (not state) so the consumer of `sampleAt` can poll on
     *  every mousemove without forcing re-renders or stale closures. */
    const activeRawRef = useRef<LoadedClimateRaw | null>(null);
    const tempminRawRef = useRef<LoadedClimateRaw | null>(null);
    const tempmaxRawRef = useRef<LoadedClimateRaw | null>(null);
    const activeCropRef = useRef<CropTolerance | null>(null);

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
    // (no threshold, temperature layers), the dynamically-stretched
    // colorize render (no threshold, unit layers), or a worker-derived
    // mask PNG (any threshold mode). Also keeps `*RawRef` populated so
    // `sampleAt` can answer cursor probes synchronously.
    useEffect(() => {
        if (!activeKind) {
            // Disable: clear UI state but keep cached source data warm
            // so re-toggling is instant.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setOverlayUrl(null);
            setStatus("idle");
            setError(null);
            setIsMasked(false);
            activeRawRef.current = null;
            tempminRawRef.current = null;
            tempmaxRawRef.current = null;
            activeCropRef.current = null;
            return;
        }

        const abortFlag = { aborted: false };
        setError(null);
        setStatus("loading");

        const isCrop = debouncedOp?.kind === "crop_band";
        activeCropRef.current = isCrop ? findCrop(cropId) : null;

        // Always load raw for the active layer so the cursor probe can
        // sample values regardless of whether we're rendering the
        // bundled color PNG or a worker-derived mask.
        const activeRawPromise = loadClimateRaw(activeKind);
        activeRawPromise.then((raw) => {
            if (abortFlag.aborted) return;
            activeRawRef.current = raw;
        });
        // Crop mode also needs both temp rasters loaded for probe + mask.
        if (isCrop) {
            loadClimateRaw("tempmin").then((raw) => {
                if (abortFlag.aborted) return;
                tempminRawRef.current = raw;
            });
            loadClimateRaw("tempmax").then((raw) => {
                if (abortFlag.aborted) return;
                tempmaxRawRef.current = raw;
            });
        } else {
            tempminRawRef.current = null;
            tempmaxRawRef.current = null;
        }

        if (!debouncedOp) {
            // Plain mode. Temperature layers reuse the bundled PNG (the
            // anchors are pinned to specific real-world °C values, so
            // the static gradient is meaningful). Unit-range layers are
            // re-colorized with a contrast-stretched gradient anchored
            // to the actual p1/p99 of the data.
            if (!needsAutoStretch(activeKind)) {
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

            // Auto-stretched colorize for unit layers.
            activeRawPromise
                .then((raw) => {
                    const meta = getClimateLayerMeta(activeKind);
                    if (!meta) throw new Error(`No layer meta for ${activeKind}`);
                    const stops = buildStretchedStops(
                        meta.colorAnchors,
                        raw.percentiles.p1,
                        raw.percentiles.p99,
                    );
                    return runThreshold(
                        raw.rgba.buffer as ArrayBuffer,
                        raw.width,
                        raw.height,
                        raw.decodeKind,
                        { kind: "colorize", stops },
                        [0, 0, 0],
                        0,
                        abortFlag,
                    ).then((rgba) =>
                        encodeRgbaToPngUrl(rgba, raw.width, raw.height).then((url) => ({ url })),
                    );
                })
                .then((result) => {
                    if (abortFlag.aborted) return;
                    if (lastDerivedUrlRef.current) URL.revokeObjectURL(lastDerivedUrlRef.current);
                    lastDerivedUrlRef.current = result.url;
                    setOverlayUrl(result.url);
                    setIsMasked(false);
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
        }

        // Threshold mode — fetch raw RGBA, run worker, encode result.
        // crop_band always operates on tempmin + tempmax regardless of
        // which variant the user is currently browsing as the legend.
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
    }, [activeKind, debouncedOp, cropId]);

    // Revoke the last derived URL on unmount.
    useEffect(() => {
        return () => {
            if (lastDerivedUrlRef.current) {
                URL.revokeObjectURL(lastDerivedUrlRef.current);
                lastDerivedUrlRef.current = null;
            }
        };
    }, []);

    /** Sample a single pixel of the active raster (and the temp pair, in
     *  crop mode) at a centered (TOPS) world coordinate. Returns null
     *  while raw decode is still in flight or the cursor is outside the
     *  raster bounds. The image is sampled with nearest-neighbor. */
    const sampleAt = useCallback(
        (worldX: number, worldZ: number): ClimateSampleResult | null => {
            const raw = activeRawRef.current;
            if (!raw) return null;
            const w = raw.world;
            // Centered → absolute → image px.
            const absX = worldX + CLIMATE_WORLD_CENTER_OFFSET;
            const absZ = worldZ + CLIMATE_WORLD_CENTER_OFFSET;
            const px = Math.floor((absX - w.originBlockX) / w.blocksPerPixelX);
            const pz = Math.floor((absZ - w.originBlockZ) / w.blocksPerPixelZ);
            if (px < 0 || pz < 0 || px >= raw.width || pz >= raw.height) return null;
            const offset = (pz * raw.width + px) * 4;
            const value = raw.decode(raw.rgba[offset], raw.rgba[offset + 1]);
            const out: ClimateSampleResult = {
                primary: { kind: raw.kind, value },
            };
            const crop = activeCropRef.current;
            const tmin = tempminRawRef.current;
            const tmax = tempmaxRawRef.current;
            if (crop && tmin && tmax) {
                // Both temp rasters share the same georef as `raw`, but
                // re-project against their own world transforms in case
                // they ever drift in a future export.
                const sample = (r: LoadedClimateRaw): number | null => {
                    const wr = r.world;
                    const ipx = Math.floor((absX - wr.originBlockX) / wr.blocksPerPixelX);
                    const ipz = Math.floor((absZ - wr.originBlockZ) / wr.blocksPerPixelZ);
                    if (ipx < 0 || ipz < 0 || ipx >= r.width || ipz >= r.height) return null;
                    const o = (ipz * r.width + ipx) * 4;
                    return r.decode(r.rgba[o], r.rgba[o + 1]);
                };
                const vmin = sample(tmin);
                const vmax = sample(tmax);
                if (vmin != null && vmax != null) {
                    out.cropCheck = {
                        tempmin: vmin,
                        tempmax: vmax,
                        cropMin: crop.minTempC,
                        cropMax: crop.maxTempC,
                        pass: vmin >= crop.minTempC && vmax <= crop.maxTempC,
                    };
                }
            }
            return out;
        },
        [],
    );

    return {
        status,
        error,
        overlayUrl: enabled ? overlayUrl : null,
        overlayBounds: enabled ? overlayBounds : null,
        activeKind,
        layerMeta,
        isMasked,
        sampleAt,
    };
}

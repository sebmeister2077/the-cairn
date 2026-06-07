/**
 * Climate threshold mask worker. Reads a raw climate PNG (each pixel
 * encodes a scalar via `(R*256+G)/k + offset`) and emits an RGBA buffer
 * where in-range pixels are tinted with `tintColor` and out-of-range
 * pixels are a soft dim ("outsideAlpha") so the underlying map remains
 * legible.
 *
 * Why a worker: the source raster is 2000×2000 (16 MB RGBA), and on
 * pan-and-zoom mid-drag we re-mask with a custom range slider. Doing
 * it on the main thread stalls the map ~20 ms on slower devices.
 */

export type ThresholdDecode = "temp" | "unit";

/** RGB triple, components 0..255. */
export type RgbTriple = [number, number, number];

/** Piecewise-linear gradient stop in the active layer's units (\u00B0C or 0..1). */
export interface ColorStop {
    value: number;
    rgb: RgbTriple;
}

export type ThresholdOp =
    | { kind: "passthrough" }
    | { kind: "min_ge"; threshold: number }
    | { kind: "max_le"; threshold: number }
    | { kind: "avg_band"; lo: number; hi: number }
    | { kind: "custom"; lo: number | null; hi: number | null }
    /** Dual-layer AND mask. Pass iff tempmin (rawBuffer) >= minThreshold
     *  and tempmax (secondRawBuffer) <= maxThreshold. Requires
     *  `secondRawBuffer` and `secondDecode` on the request. */
    | { kind: "crop_band"; minThreshold: number; maxThreshold: number }
    /** Render the raw raster as a colorized PNG using a piecewise-linear
     *  gradient. Used to replace the static (and often poorly-stretched)
     *  bundled color asset for unit-range layers like geoactivity, where
     *  the actual data distribution is heavily skewed and the bundled
     *  color anchors waste most of the visible range on near-zero pixels. */
    | { kind: "colorize"; stops: ColorStop[] };

export interface ThresholdRequest {
    requestId: number;
    rawBuffer: ArrayBuffer;
    /** Optional second source raster, used by ops that AND across two
     *  layers (currently only `crop_band`, where the first buffer is
     *  tempmin and the second is tempmax). */
    secondRawBuffer?: ArrayBuffer;
    width: number;
    height: number;
    decode: ThresholdDecode;
    secondDecode?: ThresholdDecode;
    op: ThresholdOp;
    /** RGB (0..255) for in-range pixels. Alpha is fixed at 255. */
    tintColor: [number, number, number];
    /** Alpha (0..255) for out-of-range pixels, RGB = 0,0,0. 0 = fully transparent. */
    outsideAlpha: number;
}

export interface ThresholdResponse {
    requestId: number;
    rgba: ArrayBuffer;
}

function decodeFn(kind: ThresholdDecode): (r: number, g: number) => number {
    if (kind === "temp") return (r, g) => (r * 256 + g) / 200 - 100;
    return (r, g) => (r * 256 + g) / 65535;
}

function passes(value: number, op: ThresholdOp): boolean {
    switch (op.kind) {
        case "passthrough":
            return true;
        case "min_ge":
            return value >= op.threshold;
        case "max_le":
            return value <= op.threshold;
        case "avg_band":
            return value >= op.lo && value <= op.hi;
        case "custom": {
            if (op.lo != null && value < op.lo) return false;
            if (op.hi != null && value > op.hi) return false;
            return true;
        }
        case "crop_band":
            // Single-layer fallback path is unreachable — `crop_band` is
            // dispatched via the dual-buffer branch in the message handler.
            return false;
        case "colorize":
            // Same — `colorize` runs in its own branch and never goes
            // through this filter helper.
            return false;
    }
}

/** Find bracketing stops via linear scan (stops are tiny — at most a
 *  few dozen). Returns `[lo, hi, t]` where `t` is the 0..1 lerp parameter
 *  between `lo` and `hi`. Out-of-range values clamp to the endpoints. */
function lerpColor(value: number, stops: ColorStop[]): RgbTriple {
    if (stops.length === 0) return [0, 0, 0];
    if (stops.length === 1) return stops[0].rgb;
    if (value <= stops[0].value) return stops[0].rgb;
    if (value >= stops[stops.length - 1].value) return stops[stops.length - 1].rgb;
    for (let i = 1; i < stops.length; i++) {
        const hi = stops[i];
        if (value <= hi.value) {
            const lo = stops[i - 1];
            const span = hi.value - lo.value;
            const t = span > 0 ? (value - lo.value) / span : 0;
            return [
                Math.round(lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * t),
                Math.round(lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * t),
                Math.round(lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * t),
            ];
        }
    }
    return stops[stops.length - 1].rgb;
}

self.onmessage = (ev: MessageEvent<ThresholdRequest>) => {
    const {
        requestId,
        rawBuffer,
        secondRawBuffer,
        width,
        height,
        decode,
        secondDecode,
        op,
        tintColor,
        outsideAlpha,
    } = ev.data;
    const src = new Uint8ClampedArray(rawBuffer);
    const out = new Uint8ClampedArray(width * height * 4);
    const dec = decodeFn(decode);
    const [tr, tg, tb] = tintColor;
    const len = width * height;

    if (op.kind === "crop_band") {
        if (!secondRawBuffer || !secondDecode) {
            // Misconfigured request — emit a fully-transparent mask so the
            // UI shows nothing rather than tinting the whole world.
            const response: ThresholdResponse = { requestId, rgba: out.buffer };
            (self as unknown as Worker).postMessage(response, [out.buffer]);
            return;
        }
        const src2 = new Uint8ClampedArray(secondRawBuffer);
        const dec2 = decodeFn(secondDecode);
        for (let i = 0; i < len; i++) {
            const o = i * 4;
            const vmin = dec(src[o], src[o + 1]);
            const vmax = dec2(src2[o], src2[o + 1]);
            if (vmin >= op.minThreshold && vmax <= op.maxThreshold) {
                out[o] = tr;
                out[o + 1] = tg;
                out[o + 2] = tb;
                out[o + 3] = 255;
            } else {
                out[o] = 0;
                out[o + 1] = 0;
                out[o + 2] = 0;
                out[o + 3] = outsideAlpha;
            }
        }
        const response: ThresholdResponse = { requestId, rgba: out.buffer };
        (self as unknown as Worker).postMessage(response, [out.buffer]);
        return;
    }

    if (op.kind === "colorize") {
        const stops = op.stops;
        for (let i = 0; i < len; i++) {
            const o = i * 4;
            const v = dec(src[o], src[o + 1]);
            const rgb = lerpColor(v, stops);
            out[o] = rgb[0];
            out[o + 1] = rgb[1];
            out[o + 2] = rgb[2];
            out[o + 3] = 255;
        }
        const response: ThresholdResponse = { requestId, rgba: out.buffer };
        (self as unknown as Worker).postMessage(response, [out.buffer]);
        return;
    }

    for (let i = 0; i < len; i++) {
        const o = i * 4;
        const r = src[o];
        const g = src[o + 1];
        const v = dec(r, g);
        if (passes(v, op)) {
            out[o] = tr;
            out[o + 1] = tg;
            out[o + 2] = tb;
            out[o + 3] = 255;
        } else {
            out[o] = 0;
            out[o + 1] = 0;
            out[o + 2] = 0;
            out[o + 3] = outsideAlpha;
        }
    }
    const response: ThresholdResponse = { requestId, rgba: out.buffer };
    (self as unknown as Worker).postMessage(response, [out.buffer]);
};

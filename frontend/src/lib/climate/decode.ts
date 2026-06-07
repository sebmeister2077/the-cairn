import type { ClimateDecoder, ClimateLayerKind } from "./types";

/** Temperature: `(R*256 + G) / 200 - 100`, range roughly -100..227 °C. */
export const decodeTemperature: ClimateDecoder = (r, g) => (r * 256 + g) / 200 - 100;

/** Unit-range layers (rainfall, geoactivity): `(R*256 + G) / 65535`, 0..1. */
export const decodeUnit: ClimateDecoder = (r, g) => (r * 256 + g) / 65535;

export function decoderFor(kind: ClimateLayerKind): ClimateDecoder {
    return kind === "tempavg" || kind === "tempmin" || kind === "tempmax"
        ? decodeTemperature
        : decodeUnit;
}

export function decodeKindFor(kind: ClimateLayerKind): "temp" | "unit" {
    return kind === "tempavg" || kind === "tempmin" || kind === "tempmax" ? "temp" : "unit";
}

/** Sample the decoded scalar value at a fractional pixel coordinate
 *  using nearest-neighbor lookup. Returns `null` if out of bounds. */
export function sampleClimateValue(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
    px: number,
    py: number,
    decode: ClimateDecoder,
): number | null {
    const x = Math.floor(px);
    const y = Math.floor(py);
    if (x < 0 || x >= width || y < 0 || y >= height) return null;
    const idx = (y * width + x) * 4;
    const r = rgba[idx];
    const g = rgba[idx + 1];
    return decode(r, g);
}

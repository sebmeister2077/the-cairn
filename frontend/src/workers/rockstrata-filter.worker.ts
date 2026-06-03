/**
 * Rock-strata color-keep filter. Runs off the main thread because finer
 * exports (≥10 blocks/pixel over a 20 km box → 4 Mpx and up) take long
 * enough on slower devices to stutter checkbox toggles.
 *
 * Protocol: one request → one response. The `rgba` ArrayBuffer is
 * transferred in and back out so we never copy it. Mutation is in-place
 * per the spec — pixels not in the keep set get `a = 0`, RGB preserved.
 */

export interface FilterRequest {
    requestId: number;
    rgba: ArrayBuffer;
    width: number;
    height: number;
    /** Hex strings ("#RRGGBB", uppercase) of allowed colors. Pixels not in
     *  this set have their alpha zeroed. */
    keepHex: string[];
}

export interface FilterResponse {
    requestId: number;
    rgba: ArrayBuffer;
}

self.onmessage = (ev: MessageEvent<FilterRequest>) => {
    const { requestId, rgba, keepHex } = ev.data;
    const buf = new Uint8ClampedArray(rgba);

    // Decode the keep set into a numeric Set keyed by packed 24-bit RGB —
    // the spec describes this as a `Set<string>` of "#RRGGBB" hex strings;
    // we collapse it to ints so the hot loop avoids per-pixel string ops.
    const allowInt = new Set<number>();
    for (const h of keepHex) {
        const u = h.toUpperCase();
        if (u.length !== 7 || u.charCodeAt(0) !== 35 /* '#' */) continue;
        const v = parseInt(u.slice(1), 16);
        if (Number.isFinite(v)) allowInt.add(v);
    }

    const len = buf.length;
    for (let i = 0; i < len; i += 4) {
        const r = buf[i];
        const g = buf[i + 1];
        const b = buf[i + 2];
        const packed = (r << 16) | (g << 8) | b;
        if (!allowInt.has(packed)) {
            // Spec: zero alpha only, leave RGB intact for debuggability.
            buf[i + 3] = 0;
        }
    }

    const response: FilterResponse = { requestId, rgba: buf.buffer };
    (self as unknown as Worker).postMessage(response, [buf.buffer]);
};

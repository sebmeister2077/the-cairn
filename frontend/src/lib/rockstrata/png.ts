/**
 * Canvas-free PNG decode/encode for the rock-strata overlay.
 *
 * Browsers with anti-fingerprinting protections (LibreWolf / Firefox
 * `privacy.resistFingerprinting`) randomize all canvas readback APIs —
 * `getImageData`, `toBlob`, `toDataURL`, `convertToBlob` — unless a fresh
 * user gesture is present, logging:
 *
 *   "Blocked … from extracting canvas data because no user input was detected"
 *
 * That randomization is exactly the "random colors" symptom: the decode
 * read noise instead of the real raster, and the encode wrote noise back
 * out. To stay correct regardless of those protections we never touch a
 * canvas here — decode and encode operate directly on the PNG bytes using
 * the standard `DecompressionStream` / `CompressionStream` (both available
 * in LibreWolf/Firefox).
 *
 * Only the formats we actually ship/produce are supported: 8-bit depth,
 * non-interlaced. Decode handles colour types 0 (grey), 2 (RGB), 3
 * (palette) and 6 (RGBA); encode always emits colour type 6 (RGBA).
 */

export interface DecodedImage {
    width: number;
    height: number;
    /** Tightly packed RGBA, length = width * height * 4. */
    rgba: Uint8ClampedArray;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function inflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data as unknown as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data as unknown as BlobPart])
        .stream()
        .pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Paeth predictor (PNG spec §6.6). */
function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

/** Reverse the per-scanline PNG filters in place, returning packed samples. */
function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
    const stride = width * bpp;
    const out = new Uint8Array(stride * height);
    let pos = 0;
    for (let y = 0; y < height; y++) {
        const filter = raw[pos++];
        const outRow = y * stride;
        const prevRow = outRow - stride;
        for (let x = 0; x < stride; x++) {
            const value = raw[pos++];
            const a = x >= bpp ? out[outRow + x - bpp] : 0;
            const b = y > 0 ? out[prevRow + x] : 0;
            const c = y > 0 && x >= bpp ? out[prevRow + x - bpp] : 0;
            let recon: number;
            switch (filter) {
                case 0:
                    recon = value;
                    break;
                case 1:
                    recon = value + a;
                    break;
                case 2:
                    recon = value + b;
                    break;
                case 3:
                    recon = value + ((a + b) >> 1);
                    break;
                case 4:
                    recon = value + paeth(a, b, c);
                    break;
                default:
                    throw new Error(`Unsupported PNG filter type ${filter}`);
            }
            out[outRow + x] = recon & 0xff;
        }
    }
    return out;
}

/** Decode an 8-bit, non-interlaced PNG to RGBA without using a canvas. */
export async function decodePng(buffer: ArrayBuffer): Promise<DecodedImage> {
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
        if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("Not a PNG file");
    }
    const view = new DataView(buffer);

    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    let palette: Uint8Array | null = null;
    let transparency: Uint8Array | null = null;
    const idatParts: Uint8Array[] = [];

    let offset = 8;
    while (offset < bytes.length) {
        const length = view.getUint32(offset);
        const type =
            String.fromCharCode(bytes[offset + 4]) +
            String.fromCharCode(bytes[offset + 5]) +
            String.fromCharCode(bytes[offset + 6]) +
            String.fromCharCode(bytes[offset + 7]);
        const dataStart = offset + 8;
        if (type === "IHDR") {
            width = view.getUint32(dataStart);
            height = view.getUint32(dataStart + 4);
            bitDepth = bytes[dataStart + 8];
            colorType = bytes[dataStart + 9];
            interlace = bytes[dataStart + 12];
        } else if (type === "PLTE") {
            palette = bytes.subarray(dataStart, dataStart + length);
        } else if (type === "tRNS") {
            transparency = bytes.subarray(dataStart, dataStart + length);
        } else if (type === "IDAT") {
            idatParts.push(bytes.subarray(dataStart, dataStart + length));
        } else if (type === "IEND") {
            break;
        }
        offset = dataStart + length + 4; // skip data + CRC
    }

    if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth} (expected 8)`);
    if (interlace !== 0) throw new Error("Interlaced PNGs are not supported");

    const channelsByType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
    const channels = channelsByType[colorType];
    if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}`);

    let idatLength = 0;
    for (const part of idatParts) idatLength += part.length;
    const idat = new Uint8Array(idatLength);
    {
        let p = 0;
        for (const part of idatParts) {
            idat.set(part, p);
            p += part.length;
        }
    }

    const inflated = await inflate(idat);
    const samples = unfilter(inflated, width, height, channels);

    const rgba = new Uint8ClampedArray(width * height * 4);
    const pixelCount = width * height;
    switch (colorType) {
        case 0: // greyscale
            for (let i = 0; i < pixelCount; i++) {
                const g = samples[i];
                rgba[i * 4] = g;
                rgba[i * 4 + 1] = g;
                rgba[i * 4 + 2] = g;
                rgba[i * 4 + 3] = 255;
            }
            break;
        case 2: // RGB
            for (let i = 0; i < pixelCount; i++) {
                rgba[i * 4] = samples[i * 3];
                rgba[i * 4 + 1] = samples[i * 3 + 1];
                rgba[i * 4 + 2] = samples[i * 3 + 2];
                rgba[i * 4 + 3] = 255;
            }
            break;
        case 3: // palette
            if (!palette) throw new Error("Palette PNG missing PLTE chunk");
            for (let i = 0; i < pixelCount; i++) {
                const idx = samples[i];
                rgba[i * 4] = palette[idx * 3];
                rgba[i * 4 + 1] = palette[idx * 3 + 1];
                rgba[i * 4 + 2] = palette[idx * 3 + 2];
                rgba[i * 4 + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
            }
            break;
        case 4: // greyscale + alpha
            for (let i = 0; i < pixelCount; i++) {
                const g = samples[i * 2];
                rgba[i * 4] = g;
                rgba[i * 4 + 1] = g;
                rgba[i * 4 + 2] = g;
                rgba[i * 4 + 3] = samples[i * 2 + 1];
            }
            break;
        case 6: // RGBA
            rgba.set(samples.subarray(0, pixelCount * 4));
            break;
    }

    return { width, height, rgba };
}

// CRC-32 (PNG spec §15.2) — table built lazily on first encode.
let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function buildChunk(type: string, data: Uint8Array): Uint8Array {
    const chunk = new Uint8Array(12 + data.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
    chunk.set(data, 8);
    const crc = crc32(chunk.subarray(4, 8 + data.length));
    view.setUint32(8 + data.length, crc);
    return chunk;
}

/** Encode an RGBA buffer to PNG bytes (colour type 6) without a canvas. */
export async function encodePng(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
): Promise<Uint8Array> {
    // Prepend a filter byte (0 = None) to each scanline.
    const stride = width * 4;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
    }
    const compressed = await deflate(raw);

    const ihdr = new Uint8Array(13);
    const ihdrView = new DataView(ihdr.buffer);
    ihdrView.setUint32(0, width);
    ihdrView.setUint32(4, height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // colour type RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    const signature = new Uint8Array(PNG_SIGNATURE);
    const ihdrChunk = buildChunk("IHDR", ihdr);
    const idatChunk = buildChunk("IDAT", compressed);
    const iendChunk = buildChunk("IEND", new Uint8Array(0));

    const total =
        signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const part of [signature, ihdrChunk, idatChunk, iendChunk]) {
        out.set(part, p);
        p += part.length;
    }
    return out;
}

/** Encode an RGBA buffer to a PNG object URL without a canvas. */
export async function encodePngUrl(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
): Promise<string> {
    if (width <= 0 || height <= 0) {
        const png = await encodePng(new Uint8ClampedArray(4), 1, 1);
        return URL.createObjectURL(new Blob([png as unknown as BlobPart], { type: "image/png" }));
    }
    const png = await encodePng(rgba, width, height);
    return URL.createObjectURL(new Blob([png as unknown as BlobPart], { type: "image/png" }));
}

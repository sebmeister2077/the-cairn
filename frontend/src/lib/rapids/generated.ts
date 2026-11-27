// Loader for the *generated* (predicted from the world seed) rapids dataset
// produced by the Rapids Exporter mod and compacted by
// `tools/prepare-rapids-export/prepare_rapids_export.py`.
//
// The compact file is bundled as a lazily-loaded chunk (~0.8 MB, ~0.26 MB
// gzipped) — it only downloads when the Rapids overlay is switched on. The
// timestamped folder name doubles as the cache-buster: to refresh, re-run the
// prepare script and update the import path below.

export type RapidOutflow = "n" | "e" | "s" | "w";

/** One generated rapid source block. Marker space: spawn-relative X/Z, absolute Y. */
export interface GeneratedRapid {
    x: number;
    y: number;
    z: number;
    outflow: RapidOutflow;
    /** 0..1. 1 = certain to exist in any world generated from the TOPS seed. */
    likelihood: number;
}

export interface GeneratedRapidsScan {
    mode: string;
    center: { x: number; z: number };
    radiusBlocks: number;
    complete: boolean;
}

export interface GeneratedRapidsData {
    generatedUtc: string | null;
    scan: GeneratedRapidsScan;
    rapids: GeneratedRapid[];
}

interface CompactFile {
    v: number;
    generatedUtc?: string;
    scan: GeneratedRapidsScan;
    outflow?: RapidOutflow[];
    /** `[relX, absY, relZ, outflowIndex, likelihoodPermille]` */
    rows: number[][];
}

const DEFAULT_OUTFLOW: RapidOutflow[] = ["n", "e", "s", "w"];

let cached: Promise<GeneratedRapidsData> | null = null;

export function loadGeneratedRapids(): Promise<GeneratedRapidsData> {
    if (!cached) {
        cached = import("@/assets/GeneratedRapids/rapids_20261126_235310/rapids.compact.json")
            .then((mod) => {
                const file = mod.default as unknown as CompactFile;
                const outflowNames = file.outflow ?? DEFAULT_OUTFLOW;
                const rapids: GeneratedRapid[] = new Array(file.rows.length);
                for (let i = 0; i < file.rows.length; i++) {
                    const [x, y, z, o, l] = file.rows[i];
                    rapids[i] = {
                        x,
                        y,
                        z,
                        outflow: outflowNames[o] ?? "n",
                        likelihood: l / 1000,
                    };
                }
                return { generatedUtc: file.generatedUtc ?? null, scan: file.scan, rapids };
            })
            .catch((err: unknown) => {
                // Let a later toggle retry instead of caching the failure.
                cached = null;
                throw err;
            });
    }
    return cached;
}

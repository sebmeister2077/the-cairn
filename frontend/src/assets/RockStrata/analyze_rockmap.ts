#!/usr/bin/env -S npx tsx
/**
 * Rock strata rarity report.
 *
 * Reads a rockmap legend JSON (produced by the surface rock-strata exporter)
 * and prints per-rock rarity. The exporter only samples the top stratum, so
 * deeper-sitting igneous rocks (granite, peridotite, basalt, andesite) are
 * under-represented. The `--multiplier` flag adds a side-by-side "boosted"
 * column that scales igneous pixel counts to approximate true abundance.
 *
 * Usage:
 *   npx tsx analyze_rockmap.ts [legend.json] [--multiplier=2.5] [--igneous=code1,code2]
 *
 * Defaults:
 *   legend.json -> newest rockmap_*.json in this folder
 *   multiplier  -> 2.5
 *   igneous     -> rock-granite, rock-andesite, rock-basalt, rock-peridotite
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type LegendEntry = {
    blockId: number;
    code: string;
    pixelCount: number;
    hexcolor: string;
};

type LegendFile = {
    seed: number;
    center: { x: number; z: number };
    halfSizeBlocks: number;
    outputPx: number;
    seaLevel: number;
    approximation: string;
    worldBox: { minX: number; minZ: number; maxX: number; maxZ: number };
    legend: LegendEntry[];
};

const DEFAULT_IGNEOUS = [
    "rock-granite",
    "rock-andesite",
    "rock-basalt",
    "rock-peridotite",
];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]) {
    let inputPath: string | undefined;
    let multiplier = 2.5;
    let igneous = new Set(DEFAULT_IGNEOUS);

    for (const raw of argv) {
        if (raw.startsWith("--multiplier=")) {
            const v = Number(raw.slice("--multiplier=".length));
            if (!Number.isFinite(v) || v <= 0) {
                throw new Error(`Invalid --multiplier: ${raw}`);
            }
            multiplier = v;
        } else if (raw.startsWith("--igneous=")) {
            igneous = new Set(
                raw
                    .slice("--igneous=".length)
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
            );
        } else if (raw === "--help" || raw === "-h") {
            printHelp();
            process.exit(0);
        } else if (!raw.startsWith("--")) {
            inputPath = raw;
        } else {
            throw new Error(`Unknown flag: ${raw}`);
        }
    }

    return { inputPath, multiplier, igneous };
}

function printHelp() {
    console.log(
        [
            "Usage: npx tsx analyze_rockmap.ts [legend.json] [--multiplier=2.5] [--igneous=a,b,c]",
            "",
            "If no legend.json is given, the newest rockmap_*.json in this folder is used.",
            `Default igneous set: ${DEFAULT_IGNEOUS.join(", ")}`,
        ].join("\n"),
    );
}

function findLatestLegend(): string {
    const candidates = readdirSync(SCRIPT_DIR)
        .filter((f) => /^rockmap_.*\.json$/i.test(f) && !/\.world\.json$/i.test(f))
        .map((f) => join(SCRIPT_DIR, f))
        .sort();
    if (candidates.length === 0) {
        throw new Error(`No rockmap_*.json files found in ${SCRIPT_DIR}`);
    }
    return candidates[candidates.length - 1]!;
}

function resolveInput(p: string | undefined): string {
    if (!p) return findLatestLegend();
    return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function pad(s: string, w: number, align: "left" | "right" = "left"): string {
    if (s.length >= w) return s;
    const fill = " ".repeat(w - s.length);
    return align === "left" ? s + fill : fill + s;
}

function fmtInt(n: number): string {
    return Math.round(n).toLocaleString("en-US");
}

function fmtPct(n: number): string {
    return `${(n * 100).toFixed(2)}%`;
}

type Row = {
    code: string;
    blockId: number;
    isIgneous: boolean;
    rawPx: number;
    rawPct: number;
    boostedPx: number;
    boostedPct: number;
    deltaPct: number;
};

function buildRows(
    legend: LegendEntry[],
    igneous: Set<string>,
    multiplier: number,
): Row[] {
    const rawTotal = legend.reduce((acc, e) => acc + e.pixelCount, 0);
    const boosted = legend.map((e) => ({
        entry: e,
        isIgneous: igneous.has(e.code),
        boostedPx: e.pixelCount * (igneous.has(e.code) ? multiplier : 1),
    }));
    const boostedTotal = boosted.reduce((acc, b) => acc + b.boostedPx, 0);

    const rows: Row[] = boosted.map(({ entry, isIgneous, boostedPx }) => {
        const rawPct = rawTotal > 0 ? entry.pixelCount / rawTotal : 0;
        const boostedPct = boostedTotal > 0 ? boostedPx / boostedTotal : 0;
        return {
            code: entry.code,
            blockId: entry.blockId,
            isIgneous,
            rawPx: entry.pixelCount,
            rawPct,
            boostedPx,
            boostedPct,
            deltaPct: boostedPct - rawPct,
        };
    });

    rows.sort((a, b) => b.boostedPct - a.boostedPct);
    return rows;
}

function printTable(rows: Row[]) {
    const headers = [
        "rock code",
        "ign",
        "raw px",
        "raw %",
        "boosted px",
        "boosted %",
        "Δ pp",
    ];
    const widths = [
        Math.max(headers[0].length, ...rows.map((r) => r.code.length)),
        headers[1].length,
        Math.max(headers[2].length, ...rows.map((r) => fmtInt(r.rawPx).length)),
        Math.max(headers[3].length, ...rows.map((r) => fmtPct(r.rawPct).length)),
        Math.max(headers[4].length, ...rows.map((r) => fmtInt(r.boostedPx).length)),
        Math.max(headers[5].length, ...rows.map((r) => fmtPct(r.boostedPct).length)),
        Math.max(
            headers[6].length,
            ...rows.map((r) => {
                const ppt = (r.deltaPct * 100).toFixed(2);
                return (r.deltaPct >= 0 ? `+${ppt}` : ppt).length;
            }),
        ),
    ];

    const aligns: Array<"left" | "right"> = [
        "left",
        "left",
        "right",
        "right",
        "right",
        "right",
        "right",
    ];

    const renderRow = (cells: string[]) =>
        cells.map((c, i) => pad(c, widths[i]!, aligns[i]!)).join("  ");

    console.log(renderRow(headers));
    console.log(renderRow(widths.map((w) => "-".repeat(w))));
    for (const r of rows) {
        const ppt = (r.deltaPct * 100).toFixed(2);
        console.log(
            renderRow([
                r.code,
                r.isIgneous ? "Y" : "",
                fmtInt(r.rawPx),
                fmtPct(r.rawPct),
                fmtInt(r.boostedPx),
                fmtPct(r.boostedPct),
                r.deltaPct >= 0 ? `+${ppt}` : ppt,
            ]),
        );
    }
}

function printGroupSummary(rows: Row[]) {
    const igneous = rows.filter((r) => r.isIgneous);
    const other = rows.filter((r) => !r.isIgneous);
    const sumPct = (arr: Row[], key: "rawPct" | "boostedPct") =>
        arr.reduce((acc, r) => acc + r[key], 0);

    console.log("");
    console.log("Group totals:");
    console.log(
        `  igneous : raw ${fmtPct(sumPct(igneous, "rawPct"))}  ->  boosted ${fmtPct(
            sumPct(igneous, "boostedPct"),
        )}  (${igneous.length} types)`,
    );
    console.log(
        `  other   : raw ${fmtPct(sumPct(other, "rawPct"))}  ->  boosted ${fmtPct(
            sumPct(other, "boostedPct"),
        )}  (${other.length} types)`,
    );
}

function main() {
    const { inputPath, multiplier, igneous } = parseArgs(process.argv.slice(2));
    const resolved = resolveInput(inputPath);
    const legend = JSON.parse(readFileSync(resolved, "utf8")) as LegendFile;

    if (!Array.isArray(legend.legend) || legend.legend.length === 0) {
        throw new Error(`No 'legend' array found in ${resolved}`);
    }

    const missing = [...igneous].filter(
        (c) => !legend.legend.some((e) => e.code === c),
    );

    console.log(`File      : ${resolved}`);
    console.log(`Seed      : ${legend.seed}`);
    console.log(
        `World box : (${legend.worldBox.minX}, ${legend.worldBox.minZ}) -> (${legend.worldBox.maxX}, ${legend.worldBox.maxZ})`,
    );
    console.log(`Sample px : ${legend.outputPx} x ${legend.outputPx}`);
    console.log(
        `Igneous   : ${[...igneous].join(", ")}${missing.length ? `  (not in legend: ${missing.join(", ")})` : ""}`,
    );
    console.log(`Multiplier: ${multiplier}x  (applied to igneous only)`);
    console.log("");

    const rows = buildRows(legend.legend, igneous, multiplier);
    printTable(rows);
    printGroupSummary(rows);
}

try {
    main();
} catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
}

#!/usr/bin/env -S npx tsx
/**
 * Generates rock-prices.fods from a rockmap legend JSON.
 *
 * The output is an OpenDocument Flat XML spreadsheet with both live formulas
 * AND pre-computed cached values, so it displays correctly the moment
 * LibreOffice opens it (without needing Ctrl+Shift+F9).
 *
 * Usage:
 *   npx tsx generate_prices_fods.ts [legend.json] [--out=rock-prices.fods]
 *     [--base=3] [--boost=2.5] [--polished=3] [--cracked=6]
 *     [--igneous=rock-granite,rock-andesite,rock-basalt,rock-peridotite]
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
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
    legend: LegendEntry[];
    [k: string]: unknown;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_IGNEOUS = [
    "rock-granite",
    "rock-andesite",
    "rock-basalt",
    "rock-peridotite",
];

type Args = {
    input?: string;
    out: string;
    base: number;
    boost: number;
    polished: number;
    cracked: number;
    igneous: Set<string>;
};

function parseArgs(argv: string[]): Args {
    const a: Args = {
        out: join(SCRIPT_DIR, "rock-prices.fods"),
        base: 3,
        boost: 2.5,
        polished: 3,
        cracked: 6,
        igneous: new Set(DEFAULT_IGNEOUS),
    };
    for (const raw of argv) {
        if (raw.startsWith("--out=")) a.out = raw.slice(6);
        else if (raw.startsWith("--base=")) a.base = Number(raw.slice(7));
        else if (raw.startsWith("--boost=")) a.boost = Number(raw.slice(8));
        else if (raw.startsWith("--polished=")) a.polished = Number(raw.slice(11));
        else if (raw.startsWith("--cracked=")) a.cracked = Number(raw.slice(10));
        else if (raw.startsWith("--igneous=")) {
            a.igneous = new Set(
                raw
                    .slice(10)
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
            );
        } else if (raw === "--help" || raw === "-h") {
            console.log(
                "Usage: npx tsx generate_prices_fods.ts [legend.json] [--out=...] [--base=3] [--boost=2.5] [--polished=3] [--cracked=6] [--igneous=...]",
            );
            process.exit(0);
        } else if (!raw.startsWith("--")) {
            a.input = raw;
        } else {
            throw new Error(`Unknown flag: ${raw}`);
        }
    }
    return a;
}

function findLatestLegend(): string {
    const candidates = readdirSync(SCRIPT_DIR)
        .filter((f) => /^rockmap_.*\.json$/i.test(f) && !/\.world\.json$/i.test(f))
        .sort();
    if (candidates.length === 0) {
        throw new Error(`No rockmap_*.json files found in ${SCRIPT_DIR}`);
    }
    return join(SCRIPT_DIR, candidates[candidates.length - 1]!);
}

function escAttr(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function escText(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stringCell(value: string, style?: string): string {
    const st = style ? ` table:style-name="${style}"` : "";
    return `<table:table-cell${st} office:value-type="string"><text:p>${escText(value)}</text:p></table:table-cell>`;
}
function numberCell(value: number, style?: string, decimals = 0): string {
    const st = style ? ` table:style-name="${style}"` : "";
    return `<table:table-cell${st} office:value-type="float" office:value="${value}"><text:p>${value.toFixed(decimals)}</text:p></table:table-cell>`;
}
function formulaCell(
    formula: string,
    value: number,
    valueType: "float" | "percentage",
    displayText: string,
    style?: string,
): string {
    const st = style ? ` table:style-name="${style}"` : "";
    return `<table:table-cell${st} table:formula="${escAttr(formula)}" office:value-type="${valueType}" office:value="${value}"><text:p>${escText(displayText)}</text:p></table:table-cell>`;
}
function blankCells(n: number): string {
    return `<table:table-cell table:number-columns-repeated="${n}"/>`;
}

type Row = {
    code: string;
    isIgneous: boolean;
    rawPx: number;
    boostedPx: number;
    boostedPct: number;
    ratio: number;
    ashlarLinear: number;
    ashlarSqrt: number;
    ashlarLog: number;
    polishedLinear: number;
    polishedSqrt: number;
    polishedLog: number;
    crackedLinear: number;
    crackedSqrt: number;
    crackedLog: number;
};

function compute(legend: LegendEntry[], a: Args): { rows: Row[]; granitePct: number } {
    const sorted = [...legend].sort((x, y) => y.pixelCount - x.pixelCount);
    const boostedTotal = sorted.reduce(
        (acc, e) => acc + e.pixelCount * (a.igneous.has(e.code) ? a.boost : 1),
        0,
    );
    const graniteEntry = sorted.find((e) => e.code === "rock-granite");
    if (!graniteEntry) {
        throw new Error("rock-granite not found in legend; pricing reference is missing");
    }
    const graniteBoostedPx = graniteEntry.pixelCount * (a.igneous.has("rock-granite") ? a.boost : 1);
    const granitePct = graniteBoostedPx / boostedTotal;

    const rows: Row[] = sorted.map((e) => {
        const isIgneous = a.igneous.has(e.code);
        const boostedPx = e.pixelCount * (isIgneous ? a.boost : 1);
        const boostedPct = boostedPx / boostedTotal;
        const ratio = boostedPct === 0 ? 0 : granitePct / boostedPct;
        const linearAshlarRaw = a.base * ratio;
        const sqrtAshlarRaw = a.base * Math.sqrt(ratio);
        const logAshlarRaw = Math.max(1, a.base * (1 + Math.log(ratio)));
        return {
            code: e.code,
            isIgneous,
            rawPx: e.pixelCount,
            boostedPx,
            boostedPct,
            ratio,
            ashlarLinear: Math.round(linearAshlarRaw),
            ashlarSqrt: Math.round(sqrtAshlarRaw),
            ashlarLog: Math.round(logAshlarRaw),
            polishedLinear: Math.round(linearAshlarRaw * a.polished),
            polishedSqrt: Math.round(sqrtAshlarRaw * a.polished),
            polishedLog: Math.round(logAshlarRaw * a.polished),
            crackedLinear: Math.round(linearAshlarRaw * a.cracked),
            crackedSqrt: Math.round(sqrtAshlarRaw * a.cracked),
            crackedLog: Math.round(logAshlarRaw * a.cracked),
        };
    });
    return { rows, granitePct };
}

function buildDataRow(r: Row, sheetRow: number): string {
    // sheetRow is the 1-based spreadsheet row number where this data row lives.
    const cells: string[] = [];
    cells.push(stringCell(r.code));
    cells.push(stringCell(r.isIgneous ? "Y" : ""));
    cells.push(numberCell(r.rawPx, "num-cell"));
    cells.push(
        formulaCell(
            `of:=[.C${sheetRow}]*IF([.B${sheetRow}]="Y";[.$B$5];1)`,
            r.boostedPx,
            "float",
            String(r.boostedPx),
            "num-cell",
        ),
    );
    cells.push(
        formulaCell(
            `of:=[.D${sheetRow}]/SUM([.$D$13:.$D$25])`,
            r.boostedPct,
            "percentage",
            (r.boostedPct * 100).toFixed(2) + "%",
            "pct-cell",
        ),
    );
    cells.push(
        formulaCell(
            `of:=IF([.E${sheetRow}]=0;0;[.$B$8]/[.E${sheetRow}])`,
            r.ratio,
            "float",
            r.ratio.toFixed(2),
            "num2-cell",
        ),
    );
    // Ashlar prices
    cells.push(
        formulaCell(
            `of:=ROUND([.$B$4]*[.F${sheetRow}];0)`,
            r.ashlarLinear,
            "float",
            String(r.ashlarLinear),
            "ashlar-cell",
        ),
    );
    cells.push(
        formulaCell(
            `of:=ROUND([.$B$4]*SQRT([.F${sheetRow}]);0)`,
            r.ashlarSqrt,
            "float",
            String(r.ashlarSqrt),
            "ashlar-cell",
        ),
    );
    cells.push(
        formulaCell(
            `of:=ROUND(MAX(1;[.$B$4]*(1+LN(MAX([.F${sheetRow}];0.0000001))));0)`,
            r.ashlarLog,
            "float",
            String(r.ashlarLog),
            "ashlar-cell",
        ),
    );
    // Polished
    cells.push(
        formulaCell(
            `of:=ROUND([.$B$4]*[.F${sheetRow}]*[.$B$6];0)`,
            r.polishedLinear,
            "float",
            String(r.polishedLinear),
            "price-cell",
        ),
    );
    cells.push(
        formulaCell(
            `of:=ROUND([.$B$4]*SQRT([.F${sheetRow}])*[.$B$6];0)`,
            r.polishedSqrt,
            "float",
            String(r.polishedSqrt),
            "price-cell",
        ),
    );
    cells.push(
        formulaCell(
            `of:=ROUND(MAX(1;[.$B$4]*(1+LN(MAX([.F${sheetRow}];0.0000001))))*[.$B$6];0)`,
            r.polishedLog,
            "float",
            String(r.polishedLog),
            "price-cell",
        ),
    );
    // Cracked
    cells.push(
        formulaCell(
            `of:=ROUND([.$B$4]*[.F${sheetRow}]*[.$B$7];0)`,
            r.crackedLinear,
            "float",
            String(r.crackedLinear),
            "price-cell",
        ),
    );
    cells.push(
        formulaCell(
            `of:=ROUND([.$B$4]*SQRT([.F${sheetRow}])*[.$B$7];0)`,
            r.crackedSqrt,
            "float",
            String(r.crackedSqrt),
            "price-cell",
        ),
    );
    cells.push(
        formulaCell(
            `of:=ROUND(MAX(1;[.$B$4]*(1+LN(MAX([.F${sheetRow}];0.0000001))))*[.$B$7];0)`,
            r.crackedLog,
            "float",
            String(r.crackedLog),
            "price-cell",
        ),
    );

    return `<table:table-row>${cells.join("")}</table:table-row>`;
}

function buildFods(rows: Row[], granitePct: number, a: Args, seed: number): string {
    // Pad to 13 data rows so the SUM range $D$13:$D$25 always covers everything.
    // (If legend has fewer than 13 rocks, pad with blank rows.)
    const dataStartRow = 13;
    const dataEndRow = 25;
    const slots = dataEndRow - dataStartRow + 1;
    const dataRows: string[] = [];
    for (let i = 0; i < slots; i++) {
        if (i < rows.length) {
            dataRows.push(buildDataRow(rows[i]!, dataStartRow + i));
        } else {
            // Empty padding row that still sits in the SUM range as 0.
            const padCells: string[] = [
                stringCell(""),
                stringCell(""),
                numberCell(0, "num-cell"),
            ];
            for (let c = 0; c < 12; c++) {
                padCells.push(`<table:table-cell/>`);
            }
            dataRows.push(`<table:table-row>${padCells.join("")}</table:table-row>`);
        }
    }

    const totalRawPx = rows.reduce((acc, r) => acc + r.rawPx, 0);
    const totalBoostedPx = rows.reduce((acc, r) => acc + r.boostedPx, 0);

    return `<?xml version="1.0" encoding="UTF-8"?>
<office:document
    xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
    xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
    xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
    xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
    xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
    xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"
    xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"
    xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    office:version="1.2"
    office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
  <office:meta>
    <meta:generator>extract-VS-waypoints/generate_prices_fods.ts</meta:generator>
    <dc:title>Rock pricing model — Aged variants (seed ${seed})</dc:title>
  </office:meta>
  <office:automatic-styles>
    <number:percentage-style style:name="pct2">
      <number:number number:decimal-places="2" number:min-integer-digits="1"/>
      <number:text>%</number:text>
    </number:percentage-style>
    <number:number-style style:name="num2">
      <number:number number:decimal-places="2" number:min-integer-digits="1" number:grouping="true"/>
    </number:number-style>
    <number:number-style style:name="num0">
      <number:number number:decimal-places="0" number:min-integer-digits="1" number:grouping="true"/>
    </number:number-style>
    <style:style style:name="title" style:family="table-cell">
      <style:text-properties fo:font-weight="bold" fo:font-size="14pt"/>
    </style:style>
    <style:style style:name="section" style:family="table-cell">
      <style:table-cell-properties fo:background-color="#bdd7ee"/>
      <style:text-properties fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="header" style:family="table-cell">
      <style:table-cell-properties fo:background-color="#dddddd"/>
      <style:text-properties fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="config-key" style:family="table-cell">
      <style:text-properties fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="config-val" style:family="table-cell" style:data-style-name="num2">
      <style:table-cell-properties fo:background-color="#fff2cc"/>
      <style:text-properties fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="pct-cell" style:family="table-cell" style:data-style-name="pct2"/>
    <style:style style:name="num-cell" style:family="table-cell" style:data-style-name="num0"/>
    <style:style style:name="num2-cell" style:family="table-cell" style:data-style-name="num2"/>
    <style:style style:name="price-cell" style:family="table-cell" style:data-style-name="num0">
      <style:table-cell-properties fo:background-color="#e2efda"/>
    </style:style>
    <style:style style:name="ashlar-cell" style:family="table-cell" style:data-style-name="num0">
      <style:table-cell-properties fo:background-color="#c6e0b4"/>
      <style:text-properties fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="col-narrow" style:family="table-column">
      <style:table-column-properties style:column-width="1.6cm"/>
    </style:style>
    <style:style style:name="col-wide" style:family="table-column">
      <style:table-column-properties style:column-width="4.5cm"/>
    </style:style>
    <style:style style:name="col-med" style:family="table-column">
      <style:table-column-properties style:column-width="2.4cm"/>
    </style:style>
  </office:automatic-styles>
  <office:body>
    <office:spreadsheet>
      <table:calculation-settings table:case-sensitive="false" table:precision-as-shown="false" table:search-criteria-must-apply-to-whole-cell="true" table:automatic-find-labels="false" table:use-regular-expressions="false" table:use-wildcards="true"/>
      <table:table table:name="Prices">
        <table:table-column table:style-name="col-wide"/>
        <table:table-column table:style-name="col-narrow"/>
        <table:table-column table:style-name="col-med" table:number-columns-repeated="13"/>

        <table:table-row>
          <table:table-cell table:style-name="title" office:value-type="string"><text:p>Rock pricing model — Aged variants (seed ${seed})</text:p></table:table-cell>
          ${blankCells(14)}
        </table:table-row>
        <table:table-row>${blankCells(15)}</table:table-row>

        <table:table-row>
          ${stringCell("Setting", "section")}
          ${stringCell("Value", "section")}
          ${stringCell("Notes", "section")}
          ${blankCells(12)}
        </table:table-row>

        <table:table-row>
          ${stringCell("Base price (Aged Granite Ashlar)", "config-key")}
          ${numberCell(a.base, "config-val", 2)}
          ${stringCell("rusty gears per block")}
          ${blankCells(12)}
        </table:table-row>

        <table:table-row>
          ${stringCell("Igneous boost multiplier", "config-key")}
          ${numberCell(a.boost, "config-val", 2)}
          ${stringCell("granite/andesite/basalt/peridotite raw px × this")}
          ${blankCells(12)}
        </table:table-row>

        <table:table-row>
          ${stringCell("Polished multiplier (× ashlar)", "config-key")}
          ${numberCell(a.polished, "config-val", 2)}
          ${stringCell("Aged Polished price = ashlar × this")}
          ${blankCells(12)}
        </table:table-row>

        <table:table-row>
          ${stringCell("Cracked/Tiles multiplier (× ashlar)", "config-key")}
          ${numberCell(a.cracked, "config-val", 2)}
          ${stringCell("= 2× polished by default")}
          ${blankCells(12)}
        </table:table-row>

        <table:table-row>
          ${stringCell("Granite boosted % (auto)", "config-key")}
          ${formulaCell(
        `of:=VLOOKUP("rock-granite";[.A13:.E25];5;0)`,
        granitePct,
        "percentage",
        (granitePct * 100).toFixed(2) + "%",
        "pct-cell",
    )}
          ${stringCell("auto from table below — do not edit")}
          ${blankCells(12)}
        </table:table-row>

        <table:table-row>${blankCells(15)}</table:table-row>
        <table:table-row>${blankCells(15)}</table:table-row>

        <table:table-row>
          ${stringCell("Rarity → prices (yellow = config inputs, dark green = ashlar, light green = polished/cracked)", "section")}
          ${blankCells(14)}
        </table:table-row>

        <table:table-row>
          ${stringCell("Rock", "header")}
          ${stringCell("Igneous?", "header")}
          ${stringCell("Raw px", "header")}
          ${stringCell("Boosted px", "header")}
          ${stringCell("Boosted %", "header")}
          ${stringCell("Rarity ratio", "header")}
          ${stringCell("Ashlar (Linear)", "header")}
          ${stringCell("Ashlar (Sqrt)", "header")}
          ${stringCell("Ashlar (Log)", "header")}
          ${stringCell("Polished (Linear)", "header")}
          ${stringCell("Polished (Sqrt)", "header")}
          ${stringCell("Polished (Log)", "header")}
          ${stringCell("Cracked (Linear)", "header")}
          ${stringCell("Cracked (Sqrt)", "header")}
          ${stringCell("Cracked (Log)", "header")}
        </table:table-row>

        ${dataRows.join("\n        ")}

        <table:table-row>${blankCells(15)}</table:table-row>

        <table:table-row>
          ${stringCell("Total", "config-key")}
          <table:table-cell/>
          ${formulaCell(
        `of:=SUM([.C13:.C25])`,
        totalRawPx,
        "float",
        String(totalRawPx),
        "num-cell",
    )}
          ${formulaCell(
        `of:=SUM([.D13:.D25])`,
        totalBoostedPx,
        "float",
        String(totalBoostedPx),
        "num-cell",
    )}
          ${formulaCell(
        `of:=SUM([.E13:.E25])`,
        1,
        "percentage",
        "100.00%",
        "pct-cell",
    )}
          ${blankCells(10)}
        </table:table-row>
      </table:table>

      <table:table table:name="How to use">
        <table:table-column table:style-name="col-wide" table:number-columns-repeated="2"/>
        <table:table-row>
          ${stringCell("How to use this sheet", "title")}
        </table:table-row>
        <table:table-row><table:table-cell/></table:table-row>
        <table:table-row>${stringCell("1. Open the \"Prices\" sheet.")}</table:table-row>
        <table:table-row>${stringCell("2. Edit yellow cells B4:B7 to change base price, igneous boost, and variant multipliers.")}</table:table-row>
        <table:table-row>${stringCell("3. Three rarity curves are shown side-by-side; pick the one that feels right for your economy.")}</table:table-row>
        <table:table-row>${stringCell("4. Re-run generate_prices_fods.ts whenever the rockmap JSON changes.")}</table:table-row>
        <table:table-row><table:table-cell/></table:table-row>
        <table:table-row>${stringCell("Curve definitions (let r = granite_boosted% / rock_boosted%)", "config-key")}</table:table-row>
        <table:table-row>${stringCell("Linear:")}${stringCell("price = base * r            (true inverse rarity, biggest spread)")}</table:table-row>
        <table:table-row>${stringCell("Sqrt:")}${stringCell("price = base * SQRT(r)      (gentler, recommended)")}</table:table-row>
        <table:table-row>${stringCell("Log:")}${stringCell("price = base * (1 + LN(r))  (very compressed; clamped to min 1)")}</table:table-row>
        <table:table-row><table:table-cell/></table:table-row>
        <table:table-row>${stringCell("Variants", "config-key")}</table:table-row>
        <table:table-row>${stringCell("Ashlar:")}${stringCell("price as computed by curve")}</table:table-row>
        <table:table-row>${stringCell("Polished:")}${stringCell("ashlar curve × Polished multiplier (default 3)")}</table:table-row>
        <table:table-row>${stringCell("Cracked/Tiles:")}${stringCell("ashlar curve × Cracked multiplier (default 6 = 2× polished)")}</table:table-row>
      </table:table>
    </office:spreadsheet>
  </office:body>
</office:document>
`;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const input = args.input
        ? isAbsolute(args.input)
            ? args.input
            : resolve(process.cwd(), args.input)
        : findLatestLegend();
    const legend = JSON.parse(readFileSync(input, "utf8")) as LegendFile;
    if (!Array.isArray(legend.legend) || legend.legend.length === 0) {
        throw new Error(`No 'legend' array in ${input}`);
    }
    if (legend.legend.length > 13) {
        console.warn(
            `Warning: legend has ${legend.legend.length} rocks but the sheet only renders 13 data slots. Truncating.`,
        );
    }

    const { rows, granitePct } = compute(legend.legend.slice(0, 13), args);
    const xml = buildFods(rows, granitePct, args, legend.seed);
    const outPath = isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out);
    writeFileSync(outPath, xml, "utf8");
    console.log(`Wrote ${outPath}`);
    console.log(`Source legend: ${input}`);
    console.log(
        `Base=${args.base}  Boost=${args.boost}x  Polished=${args.polished}x  Cracked=${args.cracked}x`,
    );
    console.log(`Igneous: ${[...args.igneous].join(", ")}`);
    console.log(`Granite boosted %: ${(granitePct * 100).toFixed(2)}%`);
}

try {
    main();
} catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
}

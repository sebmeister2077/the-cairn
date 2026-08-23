// Maps a Vintage Story block code to a representative colour for rendering a
// chiseled/microblock design. We don't have the game's texture atlas, so each
// voxel material is drawn as a solid colour: a curated palette for common
// rock/ore/soil/glass families, an embedded colour word when present
// (e.g. "glass-blue"), and a deterministic HSL fallback so unknown materials
// still render distinctly and stably.

const stripDomain = (code: string) => code.split(":").pop() ?? code;

// Named colour words that can appear inside a block code (glass-blue,
// rock-redmarble, wool-lightblue…). Checked as substrings, longest first.
const COLOR_WORDS: Array<[string, string]> = [
    ["lightblue", "#7ec8e3"],
    ["darkblue", "#1f3a93"],
    ["blue", "#3b6fd4"],
    ["green", "#4a9e5c"],
    ["red", "#b6413a"],
    ["orange", "#d98032"],
    ["yellow", "#d9c04a"],
    ["purple", "#7d4aa8"],
    ["pink", "#d98cb0"],
    ["brown", "#7a5230"],
    ["black", "#2b2b2f"],
    ["white", "#e6e6e6"],
    ["gray", "#8a8a8a"],
    ["grey", "#8a8a8a"],
    ["cyan", "#3ba3a3"],
    ["magenta", "#b64a9e"],
];

// Specific block codes with a hand-picked colour (overrides family/colour-word).
const EXACT: Record<string, string> = {
    "rock-obsidian": "#1c1a24",
    "rock-redmarble": "#a8514c",
    "rock-greenmarble": "#5f8a6b",
    "rock-chalk": "#e4e0d4",
    "rock-slate": "#5a5f66",
    "rock-basalt": "#3b3b40",
    "rock-chert": "#7d7466",
    "rock-bauxite": "#a9704f",
    "rock-peridotite": "#5b6b52",
    snowblock: "#f2f6fb",
    coalpile: "#26262a",
    "plaster-plain": "#d8d2c4",
};

// Broad material families keyed by the first code segment.
const FAMILY: Record<string, string> = {
    rock: "#8a8378",
    stonebricks: "#8f8a80",
    stonebrick: "#8f8a80",
    gravel: "#9a9184",
    sand: "#d9c79a",
    soil: "#6b4f34",
    peat: "#5a4632",
    clay: "#9a7b5a",
    rawclay: "#9a7b5a",
    ore: "#726b7a",
    glass: "#a9d4e0",
    plaster: "#d8d2c4",
    plank: "#b8925a",
    planks: "#b8925a",
    log: "#7a5a34",
    debarkedlog: "#a07845",
    wool: "#cfc6bb",
    brick: "#a8543f",
    metal: "#9aa0a8",
    ingot: "#9aa0a8",
    wood: "#8a6a3c",
};

function hashHsl(code: string): string {
    let h = 0;
    for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) | 0;
    const hue = Math.abs(h) % 360;
    return `hsl(${hue} 42% 55%)`;
}

/** Representative colour for a chiseled-block material code. */
export function chiselColor(code: string | undefined | null): string {
    if (!code) return "#8a8378";
    const c = stripDomain(code).toLowerCase();
    if (EXACT[c]) return EXACT[c];
    for (const [word, color] of COLOR_WORDS) {
        if (c.includes(word)) return color;
    }
    const family = c.split("-")[0];
    if (FAMILY[family]) return FAMILY[family];
    return hashHsl(c);
}

// Resolves a tapestry group's artwork. Tapestries aren't in the survival
// handbook or (usually) the wiki, so we ship prepared images under
// `assets/Auction/Images/Tapestry/`. Vite bundles them via `import.meta.glob`
// and we map each in-game type base (e.g. "ambush", "rotbeast") to its file.

const modules = import.meta.glob(
    "../../assets/Auction/Images/Tapestry/*.{png,jpg,jpeg,webp}",
    { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

// filename-without-extension (lowercase) -> bundled URL
const byName: Record<string, string> = {};
for (const [path, url] of Object.entries(modules)) {
    const file = path.split("/").pop() ?? "";
    const name = file.replace(/\.[^.]+$/, "").toLowerCase();
    byName[name] = url;
}

// Type bases whose in-game code doesn't match the prepared image's filename.
const ALIASES: Record<string, string> = {
    rotbeast: "rot-beast",
    themorning: "the-morning",
    tempstorm: "storm",
};

/** Bundled image URL for a tapestry type base (e.g. "ambush"), or null. */
export function getTapestryImage(base: string): string | null {
    const key = ALIASES[base] ?? base;
    return byName[key] ?? null;
}

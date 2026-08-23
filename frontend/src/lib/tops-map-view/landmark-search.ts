import type { WorldPointMarker } from "@/components/MapViewer";

/** Deduped, sorted list of landmark labels for the search combobox. */
export function buildLandmarkSuggestions(
    landmarks: WorldPointMarker[] | undefined,
): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const pt of landmarks ?? []) {
        const label = pt.label?.replace(/\s+/g, " ").trim() ?? "";
        if (!label) continue;
        const key = label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(label);
    }
    out.sort((a, b) => a.localeCompare(b));
    return out;
}

/** Find the first landmark whose normalised label matches `name`. */
export function findLandmarkByLabel(
    landmarks: WorldPointMarker[] | undefined,
    name: string,
): WorldPointMarker | undefined {
    const normalised = name.replace(/\s+/g, " ").trim().toLowerCase();
    const points = landmarks ?? [];
    return points.find(
        (pt) => (pt.label?.replace(/\s+/g, " ").trim().toLowerCase() ?? "") === normalised,
    );
}

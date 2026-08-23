import type { WorldPointMarker } from "@/components/MapViewer";

export interface MergeLandmarksArgs {
    usingWebCartographer: boolean;
    backendLandmarks: WorldPointMarker[] | undefined;
    wcLandmarks: WorldPointMarker[] | undefined;
}

/**
 * Merge backend + WebCartographer landmarks for the WC source: keep WC Bases
 * (minus Trader-prefixed / Terminus), backend Terminus/Server, and
 * user-contributed backend Bases that don't duplicate a nearby same-named WC base.
 */
export function mergeLandmarks({
    usingWebCartographer,
    backendLandmarks,
    wcLandmarks,
}: MergeLandmarksArgs): WorldPointMarker[] | undefined {
    if (!usingWebCartographer) return backendLandmarks;
    // Merge rule for WC source:
    //   - From the WC (official) export: keep "Base" landmarks, but drop
    //     "Trader.*" entries — those duplicate the trader overlay and
    //     clutter the map with redundant pins.
    //   - From our backend: keep "Terminus" and "Server" (our Server set
    //     is richer than WC's single Spawn marker), AND "Base" landmarks
    //     that were contributed by players (`origin === "user"`).
    //     Backend seed Bases are skipped to avoid duplicating the WC
    //     export.
    const wc = wcLandmarks;
    // Backend user Bases that already appear in the WC export (the WC
    // periodically re-ingests our contributions) would otherwise render
    // as duplicate pins. Match by normalised label first, then accept
    // anything within ~150 blocks of a same-named WC base — placement
    // jitter between in-game submission and the WC re-export can easily
    // exceed a small grid tolerance.
    const DUPLICATE_RADIUS_BLOCKS = 200;
    const DUPLICATE_RADIUS_SQ = DUPLICATE_RADIUS_BLOCKS * DUPLICATE_RADIUS_BLOCKS;
    const normaliseLabel = (s: string | undefined) =>
        (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const wcBasesByLabel = new Map<string, Array<{ x: number; z: number }>>();
    for (const p of wc ?? []) {
        if (p.kind !== "Base") continue;
        const label = normaliseLabel(p.label);
        if (!label) continue;
        const list = wcBasesByLabel.get(label) ?? [];
        list.push({ x: p.x, z: p.z });
        wcBasesByLabel.set(label, list);
    }
    const isDuplicateOfWc = (p: WorldPointMarker): boolean => {
        const label = normaliseLabel(p.label);
        if (!label) return false;
        const candidates = wcBasesByLabel.get(label);
        if (!candidates) return false;
        for (const c of candidates) {
            const dx = c.x - p.x;
            const dz = c.z - p.z;
            if (dx * dx + dz * dz <= DUPLICATE_RADIUS_SQ) return true;
        }
        return false;
    };
    const fromBackend = (backendLandmarks ?? []).filter((p) => {
        if (p.kind === "Terminus" || p.kind === "Server") return true;
        if (p.kind === "Base" && p.origin === "user") {
            return !isDuplicateOfWc(p);
        }
        return false;
    });
    const fromWc = (wc ?? []).filter(
        (p) =>
            p.kind === "Base" &&
            !(p.label ?? "").startsWith("Trader.") &&
            !(p.label ?? "").toLowerCase().includes("terminus"),
    );
    if (!wc) return fromBackend.length > 0 ? fromBackend : undefined;
    return [...fromWc, ...fromBackend];
}

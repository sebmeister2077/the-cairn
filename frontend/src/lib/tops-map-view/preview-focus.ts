import type { PreviewWalkSegment } from "@/store/slices/topsMapPreview";

/**
 * Compute the camera focus (centre + span) for the elk-walk preview mode:
 * a single focused edge, or the bounding box of every preview segment.
 */
export function computePreviewFocus(
    segments: PreviewWalkSegment[],
    focusEdgeKey: string | null,
): { x: number; z: number; spanBlocks: number } | null {
    if (segments.length === 0) return null;
    let cx = 0;
    let cz = 0;
    let span = 0;
    if (focusEdgeKey) {
        const e = segments.find((s) => s.key === focusEdgeKey);
        if (!e) return null;
        cx = (e.fromX + e.toX) / 2;
        cz = (e.fromZ + e.toZ) / 2;
        // 2x the longer axis + ~150b of padding keeps both endpoints
        // and a bit of context inside the viewport.
        span = Math.max(Math.abs(e.fromX - e.toX), Math.abs(e.fromZ - e.toZ)) * 2 + 150;
    } else {
        let minX = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxZ = -Infinity;
        for (const e of segments) {
            minX = Math.min(minX, e.fromX, e.toX);
            minZ = Math.min(minZ, e.fromZ, e.toZ);
            maxX = Math.max(maxX, e.fromX, e.toX);
            maxZ = Math.max(maxZ, e.fromZ, e.toZ);
        }
        cx = (minX + maxX) / 2;
        cz = (minZ + maxZ) / 2;
        span = Math.max(maxX - minX, maxZ - minZ) * 1.4 + 150;
    }
    if (Number.isFinite(cx) && Number.isFinite(cz) && Number.isFinite(span)) {
        return { x: cx, z: cz, spanBlocks: Math.max(span, 200) };
    }
    return null;
}

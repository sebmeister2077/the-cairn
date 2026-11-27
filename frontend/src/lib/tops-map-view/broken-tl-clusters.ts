// Zoomed-out collapsing for the recorded broken-translocator overlay. Same
// scheme as the rapids overlay (see rapids-clusters.ts): with ~60k broken TLs,
// drawing every glyph when zoomed out is far too slow, so neighbouring markers
// collapse into one count-sized cluster disc. Levels are precomputed once per
// data change; a viewport change only picks a level and culls.

import type { WorldPointMarker } from "@/components/tops-map-viewer/MapViewer";
import {
    RAPIDS_CLUSTER_CELLS,
    RAPIDS_CLUSTER_MIN_VISIBLE,
    packCell,
    pickLevel,
    type RapidsViewport,
} from "@/lib/tops-map-view/rapids-clusters";

export const BROKEN_TL_CLUSTER_COLOR = "rgba(220, 38, 38, 0.95)";

export interface BrokenTLCluster {
    /** Centroid of the members (spawn-relative). */
    x: number;
    z: number;
    count: number;
    /** The only member, when `count === 1`. */
    single: WorldPointMarker | null;
}

export interface BrokenTLClusterLevel {
    cell: number;
    clusters: BrokenTLCluster[];
}

export function buildBrokenTLClusterLevels(markers: ReadonlyArray<WorldPointMarker>): BrokenTLClusterLevel[] {
    return RAPIDS_CLUSTER_CELLS.map((cell) => {
        const byCell = new Map<number, { count: number; sumX: number; sumZ: number; single: WorldPointMarker | null }>();
        for (const m of markers) {
            const key = packCell(Math.floor(m.x / cell), Math.floor(m.z / cell));
            const c = byCell.get(key);
            if (c) {
                c.count++;
                c.sumX += m.x;
                c.sumZ += m.z;
                c.single = null;
            } else {
                byCell.set(key, { count: 1, sumX: m.x, sumZ: m.z, single: m });
            }
        }
        const clusters: BrokenTLCluster[] = [];
        for (const c of byCell.values()) {
            clusters.push({ x: c.sumX / c.count, z: c.sumZ / c.count, count: c.count, single: c.single });
        }
        return { cell, clusters };
    });
}

function clusterMarker(c: BrokenTLCluster): WorldPointMarker {
    return {
        x: c.x,
        z: c.z,
        kind: "BrokenTLCluster",
        clusterCount: c.count,
        color: BROKEN_TL_CLUSTER_COLOR,
        tooltip: {
            x: c.x,
            y: 0,
            z: c.z,
            title: `${c.count.toLocaleString()} broken TLs`,
            detail: "click to zoom",
            hideCoords: true,
        },
    };
}

/**
 * Markers to draw for the current viewport: individual broken TLs when few are
 * in view (or before the first viewport/zoom is known), otherwise the clusters
 * of the level matching the zoom. Single-member cells keep the normal glyph.
 */
export function selectBrokenTLMarkers(
    markers: ReadonlyArray<WorldPointMarker>,
    levels: BrokenTLClusterLevel[] | null,
    viewport: RapidsViewport | null,
): WorldPointMarker[] {
    if (!viewport) return markers.slice();
    const marginX = (viewport.maxX - viewport.minX) * 0.25;
    const marginZ = (viewport.maxZ - viewport.minZ) * 0.25;
    const minX = viewport.minX - marginX;
    const maxX = viewport.maxX + marginX;
    const minZ = viewport.minZ - marginZ;
    const maxZ = viewport.maxZ + marginZ;
    const inView = (x: number, z: number) => x >= minX && x <= maxX && z >= minZ && z <= maxZ;

    const visible: WorldPointMarker[] = [];
    for (const m of markers) if (inView(m.x, m.z)) visible.push(m);
    const ppb = viewport.pixelsPerBlock;
    if (visible.length < RAPIDS_CLUSTER_MIN_VISIBLE || !levels || levels.length === 0 || !ppb) {
        return visible;
    }

    const level = pickLevel(levels, ppb);
    const out: WorldPointMarker[] = [];
    for (const c of level.clusters) {
        if (!inView(c.x, c.z)) continue;
        out.push(c.single ?? clusterMarker(c));
    }
    return out;
}

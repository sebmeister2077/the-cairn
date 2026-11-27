// Zoomed-out collapsing for the Rapids overlay. With ~30k rapids, drawing
// every glyph when zoomed out is slow and unreadable, so neighbouring rapids
// collapse into one count-sized cluster marker.
//
// Cluster levels are precomputed once per data/filter change (a fixed set of
// power-of-two grid cells), so a viewport change only has to pick a level and
// cull. Collapsing stops entirely once fewer than RAPIDS_CLUSTER_MIN_VISIBLE
// rapids are in view.

import type { WorldPointMarker } from "@/components/tops-map-viewer/MapViewer";
import { RAPIDS_CLAIMED_COLOR, RAPIDS_UNCLAIMED_COLOR, type RapidMarker } from "@/lib/rapids/merge";

/** Grid cell sizes (blocks), smallest first. Each is a zoom threshold. The
 *  coarsest levels keep cells ≥ TARGET_CELL_PX apart even fully zoomed out. */
export const RAPIDS_CLUSTER_CELLS: ReadonlyArray<number> = [
    256, 512, 1024, 2048, 4096, 8192, 16384, 32768,
];
/** Below this many rapids in view, every rapid is drawn individually. */
export const RAPIDS_CLUSTER_MIN_VISIBLE = 100;
/** A level is usable once its cell spans at least this many screen px. */
const TARGET_CELL_PX = 40;

export interface RapidsCluster {
    /** Centroid of the members (spawn-relative). */
    x: number;
    z: number;
    count: number;
    unclaimed: number;
    confirmed: number;
    /** The only member, when `count === 1`. */
    single: RapidMarker | null;
}

export interface RapidsClusterLevel {
    cell: number;
    clusters: RapidsCluster[];
}

export interface RapidsViewport {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    pixelsPerBlock?: number;
}

/** Keep the predicted/claimed/likelihood filters in one place. */
export function filterRapids(
    markers: ReadonlyArray<RapidMarker>,
    opts: { showPredicted: boolean; minLikelihood: number; showClaimed: boolean },
): RapidMarker[] {
    const out: RapidMarker[] = [];
    for (const m of markers) {
        if (!opts.showClaimed && m.claimed) continue;
        if (m.source === "generated") {
            if (!opts.showPredicted || m.likelihood < opts.minLikelihood) continue;
        }
        out.push(m);
    }
    return out;
}

// Cell indices stay within ±2^15 for any world we render, so pack (cx, cz)
// into one number instead of building string keys.
const packCell = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);

export function buildRapidsClusterLevels(markers: ReadonlyArray<RapidMarker>): RapidsClusterLevel[] {
    return RAPIDS_CLUSTER_CELLS.map((cell) => {
        const byCell = new Map<number, RapidsCluster & { sumX: number; sumZ: number }>();
        for (const m of markers) {
            const key = packCell(Math.floor(m.x / cell), Math.floor(m.z / cell));
            const c = byCell.get(key);
            if (c) {
                c.count++;
                c.sumX += m.x;
                c.sumZ += m.z;
                if (!m.claimed) c.unclaimed++;
                if (m.source === "both") c.confirmed++;
                c.single = null;
            } else {
                byCell.set(key, {
                    x: 0,
                    z: 0,
                    count: 1,
                    sumX: m.x,
                    sumZ: m.z,
                    unclaimed: m.claimed ? 0 : 1,
                    confirmed: m.source === "both" ? 1 : 0,
                    single: m,
                });
            }
        }
        const clusters: RapidsCluster[] = [];
        for (const c of byCell.values()) {
            clusters.push({
                x: c.sumX / c.count,
                z: c.sumZ / c.count,
                count: c.count,
                unclaimed: c.unclaimed,
                confirmed: c.confirmed,
                single: c.single,
            });
        }
        return { cell, clusters };
    });
}

function pickLevel(levels: RapidsClusterLevel[], pixelsPerBlock: number): RapidsClusterLevel {
    for (const level of levels) {
        if (level.cell * pixelsPerBlock >= TARGET_CELL_PX) return level;
    }
    return levels[levels.length - 1];
}

function clusterMarker(c: RapidsCluster): WorldPointMarker {
    const allClaimed = c.unclaimed === 0;
    const parts = [`${c.unclaimed.toLocaleString()} unclaimed`];
    if (c.confirmed > 0) parts.push(`${c.confirmed.toLocaleString()} confirmed`);
    return {
        x: c.x,
        z: c.z,
        kind: "RapidsCluster",
        clusterCount: c.count,
        claimed: allClaimed,
        confirmed: c.confirmed > 0,
        color: allClaimed ? RAPIDS_CLAIMED_COLOR : RAPIDS_UNCLAIMED_COLOR,
        tooltip: {
            x: c.x,
            y: 0,
            z: c.z,
            title: `${c.count.toLocaleString()} rapids`,
            detail: `${parts.join(" · ")} · click to zoom`,
            hideCoords: true,
        },
    };
}

/**
 * Markers to draw for the current viewport: individual rapids when few are in
 * view (or before the first viewport/zoom is known), otherwise the clusters of
 * the level matching the zoom. Single-member cells keep the normal glyph.
 */
export function selectRapidsMarkers(
    markers: ReadonlyArray<RapidMarker>,
    levels: RapidsClusterLevel[] | null,
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

    const visible: RapidMarker[] = [];
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

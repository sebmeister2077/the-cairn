// Duplicate-waypoint detection for the Waypoint Macro Generator.
//
// "Duplicate" here is deliberately fuzzy: two waypoints don't have to share the
// exact coordinate to be considered the same marker. The user controls what
// counts as a duplicate via:
//   - maxRadius : how close two markers must be (X/Z plane, in blocks)
//   - matchColor: require the same color to be considered a duplicate
//   - matchIcon : require the same icon
//   - matchText : require the same (normalised) name
//
// Records that satisfy the active criteria are grouped into clusters via
// connected-components (A~B and B~C ⇒ A,B,C in one cluster). Only clusters with
// two or more members are returned — those are the candidates for cleanup.

import type { WaypointRecord } from "./waypoint-macro";

export interface DedupConfig {
    /** Max distance (blocks, X/Z plane) for two markers to be "the same spot". */
    maxRadius: number;
    /** Only treat markers as duplicates if their colors match. */
    matchColor: boolean;
    /** Only treat markers as duplicates if their icons match. */
    matchIcon: boolean;
    /** Only treat markers as duplicates if their names match. */
    matchText: boolean;
}

export const DEFAULT_DEDUP_CONFIG: DedupConfig = {
    maxRadius: 8,
    matchColor: false,
    matchIcon: true,
    matchText: false,
};

/** A group of two or more waypoints considered duplicates of each other. */
export interface DuplicateCluster {
    /** Stable id for the cluster (derived from its lowest member id). */
    id: string;
    /** Members sorted by id ascending (so the first is a sensible default keep). */
    members: WaypointRecord[];
}

function normalizeText(name: string | undefined): string {
    return (name ?? "").trim().toLowerCase();
}

function colorEq(a: WaypointRecord, b: WaypointRecord): boolean {
    return (a.color ?? "").toLowerCase() === (b.color ?? "").toLowerCase();
}

function iconEq(a: WaypointRecord, b: WaypointRecord): boolean {
    return (a.icon ?? "").toLowerCase() === (b.icon ?? "").toLowerCase();
}

function textEq(a: WaypointRecord, b: WaypointRecord): boolean {
    return normalizeText(a.name) === normalizeText(b.name);
}

/** Whether two records are duplicates of each other under the given config. */
export function isDuplicatePair(
    a: WaypointRecord,
    b: WaypointRecord,
    config: DedupConfig,
): boolean {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    const r = Math.max(0, config.maxRadius);
    if (dx * dx + dz * dz > r * r) return false;
    if (config.matchColor && !colorEq(a, b)) return false;
    if (config.matchIcon && !iconEq(a, b)) return false;
    if (config.matchText && !textEq(a, b)) return false;
    return true;
}

/**
 * Group records into duplicate clusters using connected components.
 *
 * Uses a union-find over a spatial grid so we only compare markers in nearby
 * cells — this keeps it fast even for large waypoint lists rather than
 * comparing every pair.
 */
export function findDuplicateClusters(
    records: WaypointRecord[],
    config: DedupConfig,
): DuplicateCluster[] {
    const n = records.length;
    if (n < 2) return [];

    // Union-find.
    const parent = new Array<number>(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (i: number): number => {
        let root = i;
        while (parent[root] !== root) root = parent[root];
        while (parent[i] !== root) {
            const next = parent[i];
            parent[i] = root;
            i = next;
        }
        return root;
    };
    const union = (a: number, b: number): void => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[ra] = rb;
    };

    // Bucket records into a grid of cell size = radius so duplicates can only
    // live in the same or an adjacent cell. A radius of 0 still works (exact
    // coordinate match) via a minimum cell size.
    const cell = Math.max(1, Math.ceil(config.maxRadius) || 1);
    const grid = new Map<string, number[]>();
    const cellKey = (cx: number, cz: number) => `${cx},${cz}`;
    for (let i = 0; i < n; i++) {
        const cx = Math.floor(records[i].x / cell);
        const cz = Math.floor(records[i].z / cell);
        const key = cellKey(cx, cz);
        const bucket = grid.get(key);
        if (bucket) bucket.push(i);
        else grid.set(key, [i]);
    }

    for (let i = 0; i < n; i++) {
        const cx = Math.floor(records[i].x / cell);
        const cz = Math.floor(records[i].z / cell);
        for (let ox = -1; ox <= 1; ox++) {
            for (let oz = -1; oz <= 1; oz++) {
                const neighbors = grid.get(cellKey(cx + ox, cz + oz));
                if (!neighbors) continue;
                for (const j of neighbors) {
                    if (j <= i) continue;
                    if (isDuplicatePair(records[i], records[j], config)) union(i, j);
                }
            }
        }
    }

    // Collect components.
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
        const root = find(i);
        const g = groups.get(root);
        if (g) g.push(i);
        else groups.set(root, [i]);
    }

    const clusters: DuplicateCluster[] = [];
    for (const indices of groups.values()) {
        if (indices.length < 2) continue;
        const members = indices
            .map((i) => records[i])
            .sort((a, b) => (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER));
        const lowestId = members[0].id;
        clusters.push({
            id: lowestId !== undefined ? `c${lowestId}` : `c${members[0].x},${members[0].z}`,
            members,
        });
    }

    // Present clusters in a stable, readable order (by first member id).
    clusters.sort((a, b) => {
        const ai = a.members[0].id ?? Number.MAX_SAFE_INTEGER;
        const bi = b.members[0].id ?? Number.MAX_SAFE_INTEGER;
        return ai - bi;
    });
    return clusters;
}

/**
 * Default deletion choice for a set of clusters: keep the first (lowest-id)
 * member of each cluster and flag the rest for deletion. Returns the set of
 * record ids to delete.
 */
export function defaultDeletionIds(clusters: DuplicateCluster[]): Set<number> {
    const ids = new Set<number>();
    for (const cluster of clusters) {
        // Skip the first member (the keeper); flag the rest.
        for (let i = 1; i < cluster.members.length; i++) {
            const id = cluster.members[i].id;
            if (id !== undefined) ids.add(id);
        }
    }
    return ids;
}

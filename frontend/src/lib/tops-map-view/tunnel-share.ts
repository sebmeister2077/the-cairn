// URL param helpers for the /tools tunnel page.
//
// Wire formats supported (the parser tries them in order):
//   - Multi-endpoint: `/tools?tls=x,y,z;x,y,z;...&topology=hub|tour|pairs&cost=total|minimax|balanced`
//   - Legacy 2-point: `/tools?from=x,y,z&to=x,y,z`
//
// Legacy params remain accepted so existing route-planner deep links
// keep working. When `tls` is present it wins.

export interface Block3 {
    x: number;
    y: number;
    z: number;
}

const PARAM_FROM = "from";
const PARAM_TO = "to";
const PARAM_TLS = "tls";
const PARAM_TOPOLOGY = "topology";
const PARAM_COST = "cost";

function encodePoint(p: Block3): string {
    return `${Math.trunc(p.x)},${Math.trunc(p.y)},${Math.trunc(p.z)}`;
}

function parsePoint(raw: string | null | undefined): Block3 | null {
    if (!raw) return null;
    const parts = raw.split(",");
    if (parts.length !== 3) return null;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { x: Math.trunc(x), y: Math.trunc(y), z: Math.trunc(z) };
}

function parseTlsList(raw: string | null | undefined): Block3[] | null {
    if (!raw) return null;
    const out: Block3[] = [];
    for (const chunk of raw.split(";")) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        const p = parsePoint(trimmed);
        if (!p) return null;
        out.push(p);
    }
    return out.length > 0 ? out : null;
}

export type ShareTopology = "pairs" | "tour" | "hub";
export type ShareCostMetric = "total" | "minimax" //| "balanced";

const TOPOLOGY_VALUES: ReadonlySet<string> = new Set(["pairs", "tour", "hub"]);
const COST_VALUES: ReadonlySet<string> = new Set(["total", "minimax" //, "balanced"
]);

function parseTopology(raw: string | null | undefined): ShareTopology | null {
    if (!raw) return null;
    return TOPOLOGY_VALUES.has(raw) ? (raw as ShareTopology) : null;
}

function parseCost(raw: string | null | undefined): ShareCostMetric | null {
    if (!raw) return null;
    return COST_VALUES.has(raw) ? (raw as ShareCostMetric) : null;
}

/** Build an absolute URL pointing at /tools with from/to coords encoded. */
export function buildTunnelToolUrl(from: Block3, to: Block3): string {
    const params = new URLSearchParams();
    params.set(PARAM_FROM, encodePoint(from));
    params.set(PARAM_TO, encodePoint(to));
    if (typeof window === "undefined") return `/tools?${params.toString()}`;
    const { origin } = window.location;
    return `${origin}/tools?${params.toString()}`;
}

/** Just the path + query — useful for `navigate(...)` calls. */
export function buildTunnelToolPath(from: Block3, to: Block3): string {
    const params = new URLSearchParams();
    params.set(PARAM_FROM, encodePoint(from));
    params.set(PARAM_TO, encodePoint(to));
    return `/tools?${params.toString()}`;
}

export interface TunnelToolParams {
    from: Block3 | null;
    to: Block3 | null;
}

/** Read from/to out of a URLSearchParams (or null entries when missing). */
export function parseTunnelToolParams(search: URLSearchParams): TunnelToolParams {
    return {
        from: parsePoint(search.get(PARAM_FROM)),
        to: parsePoint(search.get(PARAM_TO)),
    };
}

export interface MultiTunnelToolParams {
    /** Ordered list of endpoint coords. Length ≥ 2 when present. */
    tls: Block3[] | null;
    topology: ShareTopology | null;
    costMetric: ShareCostMetric | null;
}

/** Parse the new multi-endpoint URL contract. Falls back to the legacy
 *  `from` + `to` pair when `tls` is absent so old deep links still work. */
export function parseMultiTunnelParams(search: URLSearchParams): MultiTunnelToolParams {
    const tls = parseTlsList(search.get(PARAM_TLS));
    if (tls && tls.length >= 1) {
        return {
            tls,
            topology: parseTopology(search.get(PARAM_TOPOLOGY)),
            costMetric: parseCost(search.get(PARAM_COST)),
        };
    }
    // Legacy: fold from/to into the tls list so the page can use a
    // single code path downstream.
    const legacy = parseTunnelToolParams(search);
    if (legacy.from && legacy.to) {
        return {
            tls: [legacy.from, legacy.to],
            topology: parseTopology(search.get(PARAM_TOPOLOGY)),
            costMetric: parseCost(search.get(PARAM_COST)),
        };
    }
    return { tls: null, topology: null, costMetric: null };
}

interface MultiUrlOptions {
    topology?: ShareTopology | null;
    costMetric?: ShareCostMetric | null;
}

function buildMultiSearch(tls: ReadonlyArray<Block3>, opts: MultiUrlOptions): URLSearchParams {
    const params = new URLSearchParams();
    params.set(PARAM_TLS, tls.map(encodePoint).join(";"));
    if (opts.topology) params.set(PARAM_TOPOLOGY, opts.topology);
    if (opts.costMetric) params.set(PARAM_COST, opts.costMetric);
    return params;
}

/** Build an absolute URL pointing at /tools with N endpoints encoded. */
export function buildMultiTunnelUrl(
    tls: ReadonlyArray<Block3>,
    opts: MultiUrlOptions = {},
): string {
    const params = buildMultiSearch(tls, opts);
    if (typeof window === "undefined") return `/tools?${params.toString()}`;
    const { origin } = window.location;
    return `${origin}/tools?${params.toString()}`;
}

/** Path + query for `navigate(...)`. */
export function buildMultiTunnelPath(
    tls: ReadonlyArray<Block3>,
    opts: MultiUrlOptions = {},
): string {
    return `/tools?${buildMultiSearch(tls, opts).toString()}`;
}

// URL param helpers for the /tools tunnel page.
//
// Wire format:
//   /tools?from=x,y,z&to=x,y,z

export interface Block3 {
    x: number;
    y: number;
    z: number;
}

const PARAM_FROM = "from";
const PARAM_TO = "to";

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

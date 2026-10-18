// Shared color palette for tunnel endpoints / segments. Lives in
// `lib/` so it can be imported from both 3D scene code and 2D
// control panels (PatternCard, EndpointsCard) without dragging in
// three.js.

export const ENDPOINT_COLORS: ReadonlyArray<string> = [
    "#3b82f6",
    "#f97316",
    "#22c55e",
    "#ec4899",
    "#a855f7",
    "#eab308",
    "#06b6d4",
    "#ef4444",
    "#10b981",
    "#8b5cf6",
];

export const JUNCTION_COLOR = "#f8fafc";
export const SEGMENT_BLOCK_FALLBACK = "#7c7c7c";

export function endpointColor(index: number): string {
    const n = ENDPOINT_COLORS.length;
    return ENDPOINT_COLORS[((index % n) + n) % n];
}

/** Format seconds as a compact "Xm Ys" string (mins dropped when 0). */
export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds)) return "—";
    const total = Math.max(0, Math.round(seconds));
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${s}s`;
}

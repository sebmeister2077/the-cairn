/** Format seconds as a compact "Xm Ys" string (mins dropped when 0). */
export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds)) return "—";
    const total = Math.max(0, Math.round(seconds));
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${s}s`;
}

/** Format a duration in ms to a compact "1d 4h" / "12h 5m" / "5m" string. */
export function formatDurationMs(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (days >= 1) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours >= 1) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    if (minutes >= 1) return `${minutes}m`;
    return "<1m";
}

/**
 * Convert an ISO timestamp (or null) to the local-time string format
 * accepted by ``<input type="datetime-local">`` (YYYY-MM-DDTHH:mm).
 */
export function toDatetimeLocal(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `T${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
}

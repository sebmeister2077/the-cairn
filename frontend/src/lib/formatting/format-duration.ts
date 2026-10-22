import { GAME_HOURS_PER_DAY, GAME_DAYS_PER_YEAR, GAME_DAYS_PER_MONTH } from "@/lib/constants/game-dates";

/** Format seconds as a compact "Xm Ys" string (mins dropped when 0). */
export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds)) return "—";
    const total = Math.max(0, Math.round(seconds));
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m === 0) return `${s}s`;
    if (m < 60) return `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    const days = Math.floor(h / 24);
    const min = m % 60;
    if (days < 1) return `${h}h ${min}m`;
    return `${days}d ${h % 24}h`;
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


/**
 * Convert an in-game "total hours since world start" value into a display
 * calendar date (`Y{year} M{month} D{day}`), or "—" when unknown. Year, month
 * and day are 1-based to match how the in-game HUD counts them.
 */
export function formatGameDate(totalHours: number | null | undefined): string {
    if (totalHours == null || !Number.isFinite(totalHours) || totalHours <= 0) return "—";
    const totalDays = Math.floor(totalHours / GAME_HOURS_PER_DAY);
    const year = Math.floor(totalDays / GAME_DAYS_PER_YEAR);
    const dayOfYear = totalDays % GAME_DAYS_PER_YEAR;
    const month = Math.floor(dayOfYear / GAME_DAYS_PER_MONTH) + 1;
    const day = (dayOfYear % GAME_DAYS_PER_MONTH) + 1;
    return `Y${year} M${month} D${day}`;
}

export function formatSeconds(s: number | null | undefined): string {
    if (s == null) return "—";
    if (s < 60) return `${s.toFixed(0)}s`;
    if (s < 3600) return `${(s / 60).toFixed(1)}m`;
    if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
    return `${(s / 86400).toFixed(1)}d`;
}
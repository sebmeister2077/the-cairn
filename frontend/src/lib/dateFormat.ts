// User-selectable date formatting.
//
// The month is always rendered as a localized 3-letter abbreviation
// (e.g. "Aug"); only the field order and separators differ between the
// presets. `system` keeps the browser/OS numeric locale format so the
// pre-existing behavior is preserved for anyone who doesn't opt in.

export type DateFormatPref = "system" | "dmy" | "mdy" | "ymd";

export const DATE_FORMAT_PREFS: readonly DateFormatPref[] = [
    "system",
    "dmy",
    "mdy",
    "ymd",
];

export function isDateFormatPref(value: unknown): value is DateFormatPref {
    return (
        value === "system" ||
        value === "dmy" ||
        value === "mdy" ||
        value === "ymd"
    );
}

const FALLBACK = "—";

const DATE_OPTS: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
};
const TIME_OPTS: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
};

function toDate(value: string | number | Date | null | undefined): Date | null {
    if (value == null || value === "") return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function datePieces(d: Date, locale: string | undefined) {
    const parts = new Intl.DateTimeFormat(locale, DATE_OPTS).formatToParts(d);
    const get = (t: Intl.DateTimeFormatPartTypes) =>
        parts.find((p) => p.type === t)?.value ?? "";
    return { day: get("day"), month: get("month"), year: get("year") };
}

/** Format the date portion only (no time). */
export function formatDate(
    value: string | number | Date | null | undefined,
    pref: DateFormatPref,
    locale: string,
): string {
    const d = toDate(value);
    if (!d) return FALLBACK;
    if (pref === "system") {
        // Browser/OS numeric locale format (matches legacy toLocaleDateString()).
        return new Intl.DateTimeFormat(undefined).format(d);
    }
    const { day, month, year } = datePieces(d, locale);
    switch (pref) {
        case "dmy":
            return `${day} ${month} ${year}`;
        case "mdy":
            return `${month} ${day}, ${year}`;
        case "ymd":
            return `${year} ${month} ${day}`;
    }
}

/** Format date + time. */
export function formatDateTime(
    value: string | number | Date | null | undefined,
    pref: DateFormatPref,
    locale: string,
): string {
    const d = toDate(value);
    if (!d) return FALLBACK;
    if (pref === "system") {
        // Matches legacy toLocaleString(): browser/OS numeric date + time.
        return new Intl.DateTimeFormat(undefined, {
            ...DATE_OPTS,
            month: "numeric",
            ...TIME_OPTS,
        }).format(d);
    }
    const time = new Intl.DateTimeFormat(locale, TIME_OPTS).format(d);
    return `${formatDate(d, pref, locale)}, ${time}`;
}

/**
 * Format with caller-supplied Intl options while still honoring the
 * user's field-order preference. Reorders only the day/month/year values
 * in place, leaving the locale's own separators and any time parts
 * untouched. Time-only option sets are returned unchanged.
 */
export function formatWithOptions(
    value: string | number | Date | null | undefined,
    options: Intl.DateTimeFormatOptions,
    pref: DateFormatPref,
    locale: string,
): string {
    const d = toDate(value);
    if (!d) return FALLBACK;
    const dtf = new Intl.DateTimeFormat(locale, options);
    if (pref === "system") return dtf.format(d);
    const parts = dtf.formatToParts(d);
    const idx = { day: -1, month: -1, year: -1 };
    parts.forEach((p, i) => {
        if (p.type === "day" || p.type === "month" || p.type === "year") {
            idx[p.type] = i;
        }
    });
    if (idx.day < 0 || idx.month < 0 || idx.year < 0) return dtf.format(d);
    const order =
        pref === "dmy"
            ? (["day", "month", "year"] as const)
            : pref === "mdy"
                ? (["month", "day", "year"] as const)
                : (["year", "month", "day"] as const);
    const slots = [idx.day, idx.month, idx.year].sort((a, b) => a - b);
    const values = order.map((f) => parts[idx[f]].value);
    const out = parts.map((p) => p.value);
    slots.forEach((slot, i) => {
        out[slot] = values[i];
    });
    return out.join("");
}

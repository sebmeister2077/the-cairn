import { LOCALE_META } from "@/lib/i18n";
import { formatDateTime } from "@/lib/dateFormat";
import { store } from "@/store";

/** Format an ISO date string (or null) as date+time using the user's
 *  selected date-format preference. Non-React callers only — components
 *  should prefer the `useDateFormat()` hook. */
export function fmt(iso: string | null): string {
    if (!iso) return "—";
    const { i18n, dateFormat } = store.getState();
    return formatDateTime(iso, dateFormat.pref, LOCALE_META[i18n.locale].intlCode);
}

import { LOCALE_META } from "@/lib/i18n";
import { store } from "@/store";

/** Format an ISO date string or null to locale string */
export function fmt(iso: string | null): string {
    if (!iso) return "—";
    const locale = store.getState().i18n.locale;
    return new Date(iso).toLocaleString(LOCALE_META[locale].intlCode);
}

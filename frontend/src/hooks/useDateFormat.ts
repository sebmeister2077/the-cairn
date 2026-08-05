// React hook exposing the user's date-format preference plus bound
// formatting helpers. All app date rendering should go through this (or
// the store-backed `fmt` / `formatTimestamp` helpers) so formatting stays
// consistent everywhere.

import { useMemo } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { setDateFormatPref } from "@/store/slices/dateFormat";
import { LOCALE_META } from "@/lib/i18n";
import {
    formatDate,
    formatDateTime,
    type DateFormatPref,
} from "@/lib/dateFormat";

export function useDateFormat() {
    const dispatch = useAppDispatch();
    const pref = useAppSelector((s) => s.dateFormat.pref);
    const locale = useAppSelector((s) => s.i18n.locale);
    const intlCode = LOCALE_META[locale].intlCode;

    return useMemo(
        () => ({
            pref,
            setPref: (next: DateFormatPref) => dispatch(setDateFormatPref(next)),
            formatDate: (value: string | number | Date | null | undefined) =>
                formatDate(value, pref, intlCode),
            formatDateTime: (value: string | number | Date | null | undefined) =>
                formatDateTime(value, pref, intlCode),
        }),
        [pref, intlCode, dispatch],
    );
}

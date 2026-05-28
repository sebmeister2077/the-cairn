import { getByPath, interpolate, isPluralEntry, pickPlural } from "./format";
import type { ArgsForPath, Dict, PathOf, TranslationSchema } from "./types";

const warnedMissing = new Set<string>();

function warnMissing(path: string, locale: string) {
    if (!import.meta.env.DEV) return;
    const key = `${locale}:${path}`;
    if (warnedMissing.has(key)) return;
    warnedMissing.add(key);
    console.warn(`[i18n] missing key "${path}" in locale "${locale}", falling back to English`);
}

function resolveTemplate(
    entry: unknown,
    args: Record<string, string | number> | undefined,
    intlCode: string,
): string | undefined {
    if (typeof entry === "string") {
        return interpolate(entry, args);
    }
    if (isPluralEntry(entry)) {
        const count = typeof args?.count === "number" ? args.count : 0;
        return interpolate(pickPlural(intlCode, count, entry), args);
    }
    return undefined;
}

export function translate<P extends PathOf<TranslationSchema>>(
    path: P,
    args: ArgsForPath<P> | undefined,
    dictionary: Dict | undefined,
    fallback: Dict,
    locale: string,
    intlCode: string,
): string {
    const primary = getByPath(dictionary, path);
    const primaryResolved = resolveTemplate(
        primary,
        args as Record<string, string | number> | undefined,
        intlCode,
    );
    if (primaryResolved != null) return primaryResolved;

    warnMissing(path, locale);
    const fallbackResolved = resolveTemplate(
        getByPath(fallback, path),
        args as Record<string, string | number> | undefined,
        intlCode,
    );
    return fallbackResolved ?? path;
}
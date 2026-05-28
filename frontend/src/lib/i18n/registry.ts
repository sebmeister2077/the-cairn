import { en } from "./locales/en";
import type { Dict, Locale } from "./types";

export interface LocaleMeta {
    code: Locale;
    label: string;
    nativeLabel: string;
    intlCode: string;
}

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_META: Record<Locale, LocaleMeta> = {
    en: { code: "en", label: "English", nativeLabel: "English", intlCode: "en" },
    ru: { code: "ru", label: "Russian", nativeLabel: "Русский", intlCode: "ru" },
};

export const fallbackDictionary: Dict = en;

export const LOCALE_LOADERS: Record<Locale, () => Promise<Dict>> = {
    en: async () => en,
    ru: async () => (await import("./locales/ru")).default,
};
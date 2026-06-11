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
    nl: { code: "nl", label: "Dutch", nativeLabel: "Nederlands", intlCode: "nl" },
    es: { code: "es", label: "Spanish", nativeLabel: "Español", intlCode: "es" },
    fr: { code: "fr", label: "French", nativeLabel: "Français", intlCode: "fr" },
};

export const fallbackDictionary: Dict = en;

export const LOCALE_LOADERS: Record<Locale, () => Promise<Dict>> = {
    en: async () => en,
    ru: async () => (await import("./locales/ru")).default,
    nl: async () => (await import("./locales/nl")).default,
    es: async () => (await import("./locales/es")).default,
    fr: async () => (await import("./locales/fr")).default,
};
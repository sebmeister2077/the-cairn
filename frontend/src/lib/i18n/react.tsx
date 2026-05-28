import {
  cloneElement,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type ReactElement,
} from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { setLocale } from "@/store/slices/i18n";
import { translate } from "./core";
import { DEFAULT_LOCALE, fallbackDictionary, LOCALE_LOADERS, LOCALE_META } from "./registry";
import type {
  ArgsForPath,
  ArgsTuple,
  Dict,
  Locale,
  PathOf,
  PluralEntry,
  TranslationSchema,
  ValueAt,
} from "./types";

interface I18nContextValue {
  locale: Locale;
  dictionary: Dict;
  intlCode: string;
  setLocale: (next: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);
const loadedDictionaries = new Map<Locale, Dict>([[DEFAULT_LOCALE, fallbackDictionary]]);

function findMatchingClose(template: string, tagName: string, fromIndex: number): number {
  // Returns the index of the opening `<` of the matching closing tag, or -1.
  // Supports nested same-name tags by tracking depth.
  const openRe = new RegExp(`<${tagName}>`, "g");
  const closeRe = new RegExp(`</${tagName}>`, "g");
  openRe.lastIndex = fromIndex;
  closeRe.lastIndex = fromIndex;
  let depth = 1;
  let cursor = fromIndex;
  while (depth > 0) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const openMatch = openRe.exec(template);
    const closeMatch = closeRe.exec(template);
    if (!closeMatch) return -1;
    if (openMatch && openMatch.index < closeMatch.index) {
      depth += 1;
      cursor = openMatch.index + openMatch[0].length;
    } else {
      depth -= 1;
      if (depth === 0) return closeMatch.index;
      cursor = closeMatch.index + closeMatch[0].length;
    }
  }
  return -1;
}

function interpolateNodes(
  template: string,
  values: Record<string, string | number> | undefined,
  components: Record<string, ReactElement> | undefined,
): ReactNode {
  const parts: ReactNode[] = [];
  const tokenRe = /<([a-zA-Z0-9_]+)>|\{([a-zA-Z0-9_]+)\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(template)) != null) {
    const [token, tagName, valueName] = match;
    if (match.index > lastIndex) {
      parts.push(template.slice(lastIndex, match.index));
    }
    if (valueName) {
      parts.push(values?.[valueName] == null ? `{${valueName}}` : String(values[valueName]));
      lastIndex = match.index + token.length;
    } else if (tagName) {
      const contentStart = match.index + token.length;
      const closeStart = findMatchingClose(template, tagName, contentStart);
      if (closeStart === -1) {
        // No matching closing tag — emit literally so authors notice.
        parts.push(token);
        lastIndex = contentStart;
        continue;
      }
      const innerTemplate = template.slice(contentStart, closeStart);
      const children = interpolateNodes(innerTemplate, values, components);
      const component = components?.[tagName];
      parts.push(
        component
          ? cloneElement(component, { key: `${tagName}-${match.index}` }, children)
          : children,
      );
      lastIndex = closeStart + `</${tagName}>`.length;
      tokenRe.lastIndex = lastIndex;
    }
  }
  if (lastIndex < template.length) {
    parts.push(template.slice(lastIndex));
  }
  if (parts.length === 1) return parts[0];
  return parts;
}

function useI18nContext(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useTranslation must be used inside <I18nProvider>");
  return ctx;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useAppSelector((state) => state.i18n.locale);
  const dispatch = useAppDispatch();
  const [dictionary, setDictionary] = useState<Dict>(
    () => loadedDictionaries.get(locale) ?? fallbackDictionary,
  );

  useEffect(() => {
    let disposed = false;
    const cached = loadedDictionaries.get(locale);
    if (cached) {
      setDictionary(cached);
      return;
    }
    void LOCALE_LOADERS[locale]().then((next) => {
      if (disposed) return;
      loadedDictionaries.set(locale, next);
      setDictionary(next);
    });
    return () => {
      disposed = true;
    };
  }, [locale]);

  useEffect(() => {
    document.documentElement.lang = LOCALE_META[locale].intlCode;
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      dictionary,
      intlCode: LOCALE_META[locale].intlCode,
      setLocale: (next) => dispatch(setLocale(next)),
    }),
    [dictionary, dispatch, locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation() {
  const ctx = useI18nContext();

  function t<P extends PathOf<TranslationSchema>>(path: P, ...args: ArgsTuple<P>): string {
    return translate(
      path,
      args[0] as ArgsForPath<P> | undefined,
      ctx.dictionary,
      fallbackDictionary,
      ctx.locale,
      ctx.intlCode,
    );
  }

  return {
    locale: ctx.locale,
    setLocale: ctx.setLocale,
    t,
  };
}

export function useFormat() {
  const ctx = useI18nContext();
  return {
    locale: ctx.locale,
    intlCode: ctx.intlCode,
    number: (value: number, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(ctx.intlCode, options).format(value),
    dateTime: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(ctx.intlCode, options).format(new Date(value)),
  };
}

// Walk a template string at the type level and collect the names of all
// well-formed opening tags (e.g. `<strong>`, `<link>`). Closing tags
// (`</strong>`) and anything with whitespace/attributes are ignored so they
// don't pollute the required-components record.
type ExtractTagsInner<S extends string> = S extends `${string}<${infer Tag}>${infer Rest}`
  ? Tag extends `/${string}`
    ? ExtractTagsInner<Rest>
    : Tag extends `${string} ${string}`
      ? ExtractTagsInner<Rest>
      : Tag extends ""
        ? ExtractTagsInner<Rest>
        : Tag | ExtractTagsInner<Rest>
  : never;

// Resolve the leaf at a translation path to the set of tag names it uses.
// Plain string leaves are scanned directly; plural entries union the tags
// across every variant so the required components cover any plural form.
type ExtractTagsForValue<T> = T extends string
  ? ExtractTagsInner<T>
  : T extends PluralEntry
    ? ExtractTagsInner<Extract<T[keyof T & ("one" | "few" | "many" | "other")], string>>
    : never;

type NeededComponents<P extends PathOf<TranslationSchema>> = ExtractTagsForValue<
  ValueAt<TranslationSchema, P>
>;

// When a template has no tags, `components` is optional and unconstrained.
// When it has at least one tag, it becomes required and must list every tag
// the template uses.
type ComponentsProp<P extends PathOf<TranslationSchema>> = [NeededComponents<P>] extends [never]
  ? { components?: Record<string, ReactElement> }
  : { components: Record<NeededComponents<P>, ReactElement> };

type TransProps<P extends PathOf<TranslationSchema>> = {
  path: P;
  values?: ArgsForPath<P>;
} & ComponentsProp<P>;

export function Trans<P extends PathOf<TranslationSchema>>({
  path,
  values,
  components,
}: TransProps<P>) {
  const ctx = useI18nContext();
  const rendered = translate(
    path,
    values,
    ctx.dictionary,
    fallbackDictionary,
    ctx.locale,
    ctx.intlCode,
  );
  return (
    <>
      {interpolateNodes(rendered, values, components as Record<string, ReactElement> | undefined)}
    </>
  );
}

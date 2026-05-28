import type { Dict, PluralEntry, PrimitiveValue } from "./types";

const TOKEN_RE = /\{([a-zA-Z0-9_]+)\}/g;

export function getByPath(dict: Dict | undefined, path: string): unknown {
    if (!dict) return undefined;
    return path.split(".").reduce<unknown>((current, segment) => {
        if (typeof current !== "object" || current == null || Array.isArray(current)) {
            return undefined;
        }
        return (current as Record<string, unknown>)[segment];
    }, dict);
}

export function interpolate(
    template: string,
    vars?: Record<string, PrimitiveValue>,
): string {
    if (!vars) return template;
    return template.replace(TOKEN_RE, (_, name: string) => {
        const value = vars[name];
        return value == null ? `{${name}}` : String(value);
    });
}

export function isPluralEntry(value: unknown): value is PluralEntry {
    return typeof value === "object" && value != null && "other" in value;
}

export function pickPlural(intlCode: string, count: number, entry: PluralEntry): string {
    const rule = new Intl.PluralRules(intlCode).select(count);
    return entry[rule as keyof PluralEntry] ?? entry.other ?? entry.one ?? "";
}
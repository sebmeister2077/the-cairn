import type { en } from "./locales/en";

export type PrimitiveValue = string | number;

export type TWithVar<V extends string> = `${string}{${V}}${string}`;

type ExtractVarsInner<S extends string> =
    S extends `${string}{${infer Var}}${infer Rest}`
    ? Var | ExtractVarsInner<Rest>
    : never;

export type ExtractVars<S> = S extends string ? ExtractVarsInner<S> : never;

export type PluralEntry = {
    one?: string;
    few?: string;
    many?: string;
    other: string;
};

export type DictValue = string | PluralEntry | Dict;

export interface Dict {
    [key: string]: DictValue;
}

export type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepPartial<U>>
    : T[K] extends object
    ? DeepPartial<T[K]>
    : T[K];
};

export type WidenLeafStrings<T> = T extends string
    ? string
    : T extends number
    ? number
    : T extends object
    ? { [K in keyof T]: WidenLeafStrings<T[K]> }
    : T;

type Join<K extends string, P extends string> = `${K}.${P}`;

type IsPluralEntry<T> = T extends { other: string }
    ? Exclude<keyof T, "one" | "few" | "many" | "other"> extends never
    ? true
    : false
    : false;

export type PathOf<T> = T extends object
    ? {
        [K in Extract<keyof T, string>]: T[K] extends string | number
        ? K
        : IsPluralEntry<T[K]> extends true
        ? K
        : T[K] extends object
        ? Join<K, PathOf<T[K]>>
        : never;
    }[Extract<keyof T, string>]
    : never;

export type ValueAt<T, P extends string> =
    P extends `${infer Head}.${infer Tail}`
    ? Head extends keyof T
    ? ValueAt<T[Head], Tail>
    : never
    : P extends keyof T
    ? T[P]
    : never;

type VarsForPlural<T extends PluralEntry> = Exclude<
    ExtractVars<T[keyof T & ("one" | "few" | "many" | "other")]>,
    never
>;

type VarsForString<T> = Exclude<ExtractVars<T>, never>;

type RecordForVars<Vars extends string> = [Vars] extends [never]
    ? {}
    : { [K in Vars]: PrimitiveValue };

export type ArgsForValue<T> = IsPluralEntry<T> extends true
    ? RecordForVars<VarsForPlural<Extract<T, PluralEntry>>> & { count: number }
    : RecordForVars<VarsForString<T>>;

export type ArgsForPath<P extends PathOf<TranslationSchema>> = ArgsForValue<
    ValueAt<TranslationSchema, P>
>;

export type ArgsTuple<P extends PathOf<TranslationSchema>> = keyof ArgsForPath<P> extends never
    ? []
    : [args: ArgsForPath<P>];

export type Locale = "en" | "ru" | "nl" | "es" | "fr";

export type TranslationSchema = typeof en;
export type LocaleDictionary = DeepPartial<WidenLeafStrings<TranslationSchema>>;
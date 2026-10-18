// Composable filters for the Waypoint Macro Generator.
//
// Filters narrow a list of WaypointRecord down to the subset the user wants
// to turn into macro commands. Each filter is described by a plain data object
// (so the UI can edit/serialise them) and compiled into a predicate via
// `compileFilter`. `applyFilters` runs them all with AND semantics (v1).

import type { WaypointRecord } from "./waypoint-macro";

export type FilterType =
    | "name"
    | "icon"
    | "color"
    | "radius"
    | "idRange";

/** Name-based text match. */
export interface NameFilter {
    id: string;
    type: "name";
    /** "startsWith" | "notStartsWith" | "contains" | "notContains" */
    mode: "startsWith" | "notStartsWith" | "contains" | "notContains";
    value: string;
    caseSensitive: boolean;
}

/** Icon equality (only meaningful for chat-log uploads, which carry icons). */
export interface IconFilter {
    id: string;
    type: "icon";
    /** "is" | "isNot" */
    mode: "is" | "isNot";
    value: string;
}

/** Color equality. */
export interface ColorFilter {
    id: string;
    type: "color";
    mode: "is" | "isNot";
    /** Hex string. Compared case-insensitively. */
    value: string;
}

/** Distance from a center point on the X/Z plane. */
export interface RadiusFilter {
    id: string;
    type: "radius";
    /** "within" keeps points <= radius; "beyond" keeps points > radius. */
    mode: "within" | "beyond";
    x: number;
    z: number;
    radius: number;
}

/** Inclusive id range (requires records to carry an id). */
export interface IdRangeFilter {
    id: string;
    type: "idRange";
    min: number;
    max: number;
}

export type WaypointFilter =
    | NameFilter
    | IconFilter
    | ColorFilter
    | RadiusFilter
    | IdRangeFilter;

let filterSeq = 0;
/** Generate a stable-ish unique id for a new filter row. */
export function newFilterId(): string {
    filterSeq += 1;
    return `f${Date.now().toString(36)}_${filterSeq}`;
}

/** Build a default filter object for the given type. */
export function makeDefaultFilter(type: FilterType): WaypointFilter {
    const id = newFilterId();
    switch (type) {
        case "name":
            return { id, type, mode: "startsWith", value: "", caseSensitive: false };
        case "icon":
            return { id, type, mode: "is", value: "" };
        case "color":
            return { id, type, mode: "is", value: "" };
        case "radius":
            return { id, type, mode: "within", x: 0, z: 0, radius: 1000 };
        case "idRange":
            return { id, type, min: 0, max: 99 };
    }
}

function compileNameFilter(f: NameFilter): (wp: WaypointRecord) => boolean {
    const needle = f.caseSensitive ? f.value : f.value.toLowerCase();
    return (wp) => {
        if (!needle) return true; // empty filter is a no-op
        const hay = f.caseSensitive ? wp.name : wp.name.toLowerCase();
        switch (f.mode) {
            case "startsWith":
                return hay.startsWith(needle);
            case "notStartsWith":
                return !hay.startsWith(needle);
            case "contains":
                return hay.includes(needle);
            case "notContains":
                return !hay.includes(needle);
        }
    };
}

function compileIconFilter(f: IconFilter): (wp: WaypointRecord) => boolean {
    const v = f.value.trim().toLowerCase();
    return (wp) => {
        if (!v) return true;
        const matches = (wp.icon ?? "").toLowerCase() === v;
        return f.mode === "is" ? matches : !matches;
    };
}

function compileColorFilter(f: ColorFilter): (wp: WaypointRecord) => boolean {
    const v = f.value.trim().toLowerCase();
    return (wp) => {
        if (!v) return true;
        const matches = (wp.color ?? "").toLowerCase() === v;
        return f.mode === "is" ? matches : !matches;
    };
}

function compileRadiusFilter(f: RadiusFilter): (wp: WaypointRecord) => boolean {
    const r2 = f.radius * f.radius;
    return (wp) => {
        const dx = wp.x - f.x;
        const dz = wp.z - f.z;
        const dist2 = dx * dx + dz * dz;
        return f.mode === "within" ? dist2 <= r2 : dist2 > r2;
    };
}

function compileIdRangeFilter(f: IdRangeFilter): (wp: WaypointRecord) => boolean {
    const lo = Math.min(f.min, f.max);
    const hi = Math.max(f.min, f.max);
    return (wp) => {
        if (wp.id === undefined) return false;
        return wp.id >= lo && wp.id <= hi;
    };
}

/** Compile a single filter object into a predicate. */
export function compileFilter(f: WaypointFilter): (wp: WaypointRecord) => boolean {
    switch (f.type) {
        case "name":
            return compileNameFilter(f);
        case "icon":
            return compileIconFilter(f);
        case "color":
            return compileColorFilter(f);
        case "radius":
            return compileRadiusFilter(f);
        case "idRange":
            return compileIdRangeFilter(f);
    }
}

/** Apply all filters with AND semantics. An empty list returns the input. */
export function applyFilters(
    records: WaypointRecord[],
    filters: WaypointFilter[],
): WaypointRecord[] {
    if (filters.length === 0) return records;
    const predicates = filters.map(compileFilter);
    return records.filter((wp) => predicates.every((p) => p(wp)));
}

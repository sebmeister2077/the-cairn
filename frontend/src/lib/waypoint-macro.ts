// Vintage Story macro generation for the Waypoint Macro Generator tool.
//
// A VS macro file (saved under `%APPDATA%/VintagestoryData/Macros/`) is a
// JSON document with this shape:
//
//   {
//     "Index": 0,
//     "Code": "Test",
//     "Name": "Test",
//     "Commands": ["", ...],
//     "KeyCombination": { "KeyCode": null, "SecondKeyCode": null,
//                         "Ctrl": false, "Alt": false, "Shift": false,
//                         "OnKeyUp": false }
//   }
//
// The file name follows `{index}-{Name}.json`. This module turns waypoint
// records / user input into the `Commands` array of `/waypoint …` chat
// commands and serialises the macro for download.

/** A waypoint as understood by the macro generator. Coordinates are in the
 *  in-game convention (+Z = north), matching what the player types and sees
 *  in chat. */
export interface WaypointRecord {
    /** In-game waypoint id (0-based). Present for chat-log uploads; absent for
     *  geojson imports where we only know the position. */
    id?: number;
    name: string;
    x: number;
    /** Y (depth / altitude). May be undefined for geojson sources that don't
     *  store it — callers supply a default before emitting an `addati`. */
    y?: number;
    z: number;
    /** Hex color string, e.g. "#204EA2". */
    color: string;
    /** Waypoint icon code, e.g. "spiral", "trader", "pick". */
    icon: string;
    /** Whether the waypoint should be pinned (default false). */
    pinned?: boolean;
}

/** The `KeyCombination` block of a macro. We leave it unbound by default. */
export interface MacroKeyCombination {
    KeyCode: number | null;
    SecondKeyCode: number | null;
    Ctrl: boolean;
    Alt: boolean;
    Shift: boolean;
    OnKeyUp: boolean;
}

/** The serialised macro file. */
export interface MacroFile {
    Index: number;
    Code: string;
    Name: string;
    Commands: string[];
    KeyCombination: MacroKeyCombination;
}

/** User-editable macro metadata used to assemble the file + filename. */
export interface MacroMeta {
    /** Numeric file index — used in both the JSON `Index` and the filename. */
    index: number;
    /** Macro display name. Also used as the `Code`. */
    name: string;
}

export const DEFAULT_KEY_COMBINATION: MacroKeyCombination = {
    KeyCode: null,
    SecondKeyCode: null,
    Ctrl: false,
    Alt: false,
    Shift: false,
    OnKeyUp: false,
};

/** Default Y to use when a source waypoint has no known depth. */
export const DEFAULT_WAYPOINT_Y = 110;

/** VS labels can't contain newlines on a single chat command — normalise. */
function sanitizeTitle(title: string): string {
    return title.replace(/[\r\n]+/g, " ").trim();
}

/** Ensure a color is a valid `#RRGGBB` string, falling back to white. */
function sanitizeColor(color: string | undefined): string {
    if (color && /^#[0-9A-Fa-f]{6}$/.test(color)) return color;
    return "#FFFFFF";
}

/**
 * `/waypoint addati <icon> <x> <y> <z> <pinned> <color> <title>` — add a
 * waypoint at the given coordinates with an explicit icon. This is the form
 * used when re-adding waypoints from a chat-log or importing markers.
 */
export function addatiCommand(wp: WaypointRecord, fallbackY = DEFAULT_WAYPOINT_Y): string {
    const icon = wp.icon?.trim() || "circle";
    const y = Number.isFinite(wp.y as number) ? (wp.y as number) : fallbackY;
    const pinned = wp.pinned ? "true" : "false";
    const color = sanitizeColor(wp.color);
    const title = sanitizeTitle(wp.name) || "Waypoint";
    return `/waypoint addati ${icon} ${wp.x} ${y} ${wp.z} ${pinned} ${color} ${title}`;
}

/**
 * `/waypoint remove <id>` — remove a single waypoint by id.
 *
 * IMPORTANT: when a waypoint is removed, every waypoint with a *higher* id is
 * renumbered down by one. See {@link buildBulkRemoveCommands} for how to
 * delete a contiguous range correctly.
 */
export function removeCommand(id: number): string {
    return `/waypoint remove ${id}`;
}

/**
 * `/waypoint modify <id> <color> <title>` — recolor / rename a waypoint.
 */
export function modifyCommand(id: number, color: string, title: string): string {
    return `/waypoint modify ${id} ${sanitizeColor(color)} ${sanitizeTitle(title) || "Waypoint"}`;
}

/**
 * Build the commands needed to remove every waypoint whose id is in the
 * inclusive range `[startId, endId]`.
 *
 * Because removing a waypoint decrements the id of every higher waypoint, the
 * correct way to delete a contiguous block is to repeatedly remove the
 * *lowest* id in the block. e.g. to delete ids 0..99 you issue
 * `/waypoint remove 0` one hundred times: after the first removal what was id
 * 1 becomes id 0, and so on.
 */
export function buildBulkRemoveCommands(startId: number, endId: number): string[] {
    const lo = Math.min(startId, endId);
    const hi = Math.max(startId, endId);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0) return [];
    const count = hi - lo + 1;
    const out: string[] = [];
    for (let i = 0; i < count; i++) out.push(removeCommand(lo));
    return out;
}

/**
 * Build remove commands for an arbitrary (not necessarily contiguous) set of
 * waypoint ids, accounting for the auto-decrement behaviour. We remove from
 * the highest id down to the lowest so earlier removals never shift the ids
 * we still need to target.
 */
export function buildRemoveByIdsCommands(ids: number[]): string[] {
    const unique = Array.from(new Set(ids.filter((n) => Number.isInteger(n) && n >= 0)));
    unique.sort((a, b) => b - a); // descending
    return unique.map(removeCommand);
}

/** Build `addati` commands for a list of waypoint records. */
export function buildAddCommands(records: WaypointRecord[], fallbackY = DEFAULT_WAYPOINT_Y): string[] {
    return records.map((wp) => addatiCommand(wp, fallbackY));
}

/** Assemble a {@link MacroFile} from metadata and a command list. */
export function buildMacroFile(meta: MacroMeta, commands: string[]): MacroFile {
    const name = meta.name.trim() || "Macro";
    return {
        Index: Number.isFinite(meta.index) ? meta.index : 0,
        Code: name,
        Name: name,
        Commands: commands.length > 0 ? commands : [""],
        KeyCombination: { ...DEFAULT_KEY_COMBINATION },
    };
}

/** Sanitise a macro name into a safe filename fragment. */
export function macroFileName(meta: MacroMeta): string {
    const safeName = (meta.name.trim() || "Macro").replace(/[\\/:*?"<>|]+/g, "_");
    const index = Number.isFinite(meta.index) ? meta.index : 0;
    return `${index}-${safeName}.json`;
}

/** Serialise + trigger a browser download of the macro file. */
export function downloadMacro(meta: MacroMeta, commands: string[]): void {
    const macro = buildMacroFile(meta, commands);
    const blob = new Blob([JSON.stringify(macro, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = macroFileName(meta);
    a.click();
    URL.revokeObjectURL(url);
}

/** Parameter descriptor for a catalog entry. */
export interface CommandParam {
    name: string;
    description: string;
}

/** A reference entry describing an available `/waypoint` command. */
export interface CommandCatalogEntry {
    /** Stable id for keys / selection. */
    id: string;
    /** Command template shown to the user. */
    template: string;
    /** Short human description. */
    description: string;
    params: CommandParam[];
}

/**
 * Reference list of the `/waypoint` commands surfaced in the UI. Kept
 * intentionally small and practical — these are the ones the generator can
 * emit or that players commonly use.
 */
export const WAYPOINT_COMMAND_CATALOG: CommandCatalogEntry[] = [
    {
        id: "addati",
        template: "/waypoint addati <icon> <x> <y> <z> <pinned> <color> <title>",
        description: "Add a waypoint at exact coordinates with a chosen icon.",
        params: [
            { name: "icon", description: "Icon code, e.g. spiral, trader, pick, circle, star." },
            { name: "x y z", description: "World coordinates (Y is depth/altitude)." },
            { name: "pinned", description: "true or false — whether the marker stays pinned on screen." },
            { name: "color", description: "Hex color like #204EA2." },
            { name: "title", description: "Waypoint label (the rest of the line)." },
        ],
    },
    {
        id: "addat",
        template: "/waypoint addat <x> <y> <z> <pinned> <color> <title>",
        description: "Add a waypoint at exact coordinates using the default icon.",
        params: [
            { name: "x y z", description: "World coordinates (Y is depth/altitude)." },
            { name: "pinned", description: "true or false." },
            { name: "color", description: "Hex color like #204EA2." },
            { name: "title", description: "Waypoint label." },
        ],
    },
    {
        id: "add",
        template: "/waypoint add <color> <title>",
        description: "Add a waypoint at your current position.",
        params: [
            { name: "color", description: "Hex color like #204EA2." },
            { name: "title", description: "Waypoint label." },
        ],
    },
    {
        id: "modify",
        template: "/waypoint modify <id> <color> <title>",
        description: "Change the color and title of an existing waypoint.",
        params: [
            { name: "id", description: "Waypoint id from /waypoint list." },
            { name: "color", description: "New hex color." },
            { name: "title", description: "New label." },
        ],
    },
    {
        id: "remove",
        template: "/waypoint remove <id>",
        description:
            "Remove a waypoint by id. Every waypoint with a higher id is renumbered down by one afterwards.",
        params: [{ name: "id", description: "Waypoint id from /waypoint list." }],
    },
    {
        id: "list",
        template: "/waypoint list",
        description: "Print your waypoints to chat (use 'list details' for coordinates).",
        params: [],
    },
];

/** Common icon codes offered in the generator UI. */
export const COMMON_WAYPOINT_ICONS = [
    "circle",
    "star",
    "spiral",
    "trader",
    "pick",
    "rocks",
    "home",
    "ladder",
    "bee",
    "cave",
    "vessel",
    "gear",
    "turnip",
    "berries",
] as const;

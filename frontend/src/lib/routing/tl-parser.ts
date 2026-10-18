/**
 * Parser for the chat-log produced by the in-game `/waypoint list details`
 * command.
 *
 * Sample chat-log line (with timestamp/Chat prefix):
 *
 *     7.5.2026 11:35:32 [Chat] 32: Home at 2246, 121, 12557 #204EA2 spiral
 *
 * The block typically starts with `Your waypoints:` on its own line and
 * spans until the next chat message arrives. Lines may be split across the
 * `[Chat]` prefix when the game wraps long content, but in practice each
 * waypoint occupies one line.
 *
 * We strip the optional timestamp + `[Chat]` prefix and the trailing ` @ N`
 * suffix that the game appends to every chat entry, then match each
 * waypoint with a tolerant regex.
 */

import type { ParsedWaypoint } from "@/models/contributeTLs";

const WAYPOINT_RE =
    /^\s*(\d+):\s+(.+?)\s+at\s+(-?\d+),\s*(-?\d+),\s*(-?\d+)\s+(#[0-9A-Fa-f]{6})\s+(\S+)\s*$/;

/**
 * Strip the timestamp + `[Chat]` prefix and the trailing ` @ N` channel
 * suffix from a single chat-log line. Returns the inner message text.
 *
 * Examples:
 *   "7.5.2026 11:35:32 [Chat] 32: Home at ..."  ->  "32: Home at ..."
 *   "32: Home at ... @ 0"                       ->  "32: Home at ..."
 */
function stripChatLogDecorations(line: string): string {
    let out = line;

    // Drop the `D.M.YYYY HH:MM:SS [Chat] ` prefix if present.
    const prefixMatch = out.match(/^\s*\d{1,2}\.\d{1,2}\.\d{2,4}\s+\d{1,2}:\d{2}:\d{2}\s+\[Chat\]\s+/);
    if (prefixMatch) out = out.slice(prefixMatch[0].length);

    // Drop the trailing ` @ N` channel suffix (always last; N is an integer
    // possibly negative).
    out = out.replace(/\s+@\s+-?\d+\s*$/, "");

    return out.trim();
}
/**
 *Examples of valid lines that we want to parse:
    559: Peat at 2092, 119, 13129 #5D3D21 pick
    560: Clay at 2107, 118, 13167 #F15A4A rocks
    561: Peat at 1679, 119, 13789 #5D3D21 pick
    562: Treasure Hunter at 244, 121, 753 #F9D0DC trader
    563: 770 57560 at -2912, 139, 51371 #204EA2 spiral
    564: -2910 51370 (Home) at 769, 139, 57556 #204EA2 spiral
    565: -880 65200 at 892, 136, 57848 #204EA2 spiral
    566: 890 57850 (Home) at -877, 110, 65193 #204EA2 spiral
 */
/**
 * Parse all waypoint lines from the given chat-log text. Lines that don't
 * match the waypoint pattern are silently ignored (this matters because
 * `/waypoint list details` output is interleaved with other chat).
 */
export function parseChatLogWaypoints(text: string): ParsedWaypoint[] {
    if (!text) return [];
    // indicates the user has joined the correct server
    const topsWelcomeMessage = "[Chat] Welcome to the Official Public Server!";
    // indicates the user has typed the /waypoint command and the waypoint list is starting
    const startOfWaypoints = "[Chat] Your waypoints:";
    const lines = text.split(/\r?\n/);
    const out: ParsedWaypoint[] = [];

    // remove duplicate calling of the /waypoint command
    const indexSet = new Set<number>();
    let isTopsServer = false;
    let isWaypointListStarted = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const inner = stripChatLogDecorations(line);
        if (!inner) continue;
        if (line.includes(topsWelcomeMessage)) {
            isTopsServer = true;
            continue;
        }
        if (line.includes(startOfWaypoints)) {
            isWaypointListStarted = true;
            continue;
        }
        if (!isTopsServer || !isWaypointListStarted) continue;
        const m = WAYPOINT_RE.exec(inner);
        if (!m) continue;
        const [, indexStr, name, xStr, yStr, zStr, color, icon] = m;

        if (indexSet.has(Number(indexStr))) continue;
        indexSet.add(Number(indexStr));

        const x = Number(xStr);
        const y = Number(yStr);
        const z = Number(zStr);
        if (![x, y, z].every(Number.isFinite)) continue;
        out.push({
            index: Number(indexStr),
            name: name.trim(),
            x,
            y,
            z,
            color,
            icon,
            lineNumber: i + 1,
        });
    }

    return out;
}

/** Filter to translocator waypoints (icon === "spiral"). */
export function extractTLs(waypoints: ParsedWaypoint[]): ParsedWaypoint[] {
    return waypoints.filter((w) => w.icon === "spiral");
}

/**
 * Try to extract a coordinate pair from a waypoint label.
 *
 * The user's labels follow patterns like:
 *   - `"1430 -2150"`
 *   - `"-3940 40970"`
 *   - `"2200 12500 (HOME)"`
 *   - `"2460 12300 (HOME)"`
 *   - `"-700 27000"`
 *
 * We accept any two whitespace-separated signed integers near the start of
 * the label. Parenthetical suffixes are ignored. Returns `null` if no
 * coordinate pair can be parsed.
 */
export function parseLabelCoords(label: string): { x: number; z: number } | null {
    if (!label) return null;
    // Match the first two signed integers in the label. The separator can
    // be any non-digit punctuation/whitespace (comma, space, slash, parens,
    // etc.), so all of these work:
    //   "1430 -2150"
    //   "(5300,14800)"
    //   "-3940 / 40970"
    //   "2200, 12500 (HOME)"
    const m = label.match(/(-?\d{1,6})[^\d-]+(-?\d{1,6})/);
    if (!m) return null;
    const x = Number(m[1]);
    const z = Number(m[2]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    return { x, z };
}

/**
 * Client-side route normalization for the admin Usage "Pages" analytics.
 *
 * We send a short, fixed-cardinality template (e.g. ``/blog/:slug``) to the
 * server instead of the raw pathname, so the ``metadata->>'path'`` index
 * stays small no matter how many slugs / ids exist. The whitelist below
 * mirrors the React Router routes declared in ``AppContent.tsx``.
 *
 * Anything not on the whitelist no longer collapses straight to
 * ``/unknown``. Instead it goes through :func:`genericTemplate`, which
 * keeps the real path but replaces volatile-looking segments (numeric ids,
 * UUIDs, long hashes) with ``:id`` and caps the depth. That way a brand-new
 * page that hasn't been added to the list yet is still recorded under a
 * meaningful, bounded-cardinality template rather than disappearing into a
 * single ``/unknown`` bucket. Only genuinely empty / unparseable input
 * falls back to ``/unknown``.
 */

// Exact route templates registered in AppContent.tsx. Keep in sync.
const KNOWN_ROUTES: string[] = [
    "/",
    "/singleplayer/extract",
    "/singleplayer/import",
    "/singleplayer/commands",
    "/singleplayer/delete",
    "/multiplayer/identify",
    "/multiplayer/map-viewer",
    "/multiplayer/tops-map",
    "/multiplayer/contribute",
    "/multiplayer/contribute-map",
    "/multiplayer/contribute-tls",
    "/multiplayer/contribute-traders",
    "/manage/api-keys",
    "/manage/users",
    "/manage/banned-ips",
    "/manage/flags",
    "/manage/feature-flags",
    "/manage/maintenance",
    "/manage/resources",
    "/manage/waypoints-backup",
    "/manage/translocators",
    "/manage/traders",
    "/manage/tl-screenshots",
    "/manage/elk-walkable",
    "/public/road-workers",
    "/tools",
    "/tools/waypoints",
    "/market",
    "/market/listings",
    "/market/insights",
    "/market/converter",
    "/market/orders",
    "/market/leaderboards",
    "/market/map",
    "/market/items",
    "/rarity/rocks",
    "/usage",
    "/account",
    "/general",
    "/privacy",
    "/terms",
    "/blog",
];

// Dynamic routes: regex → template.
const DYNAMIC_ROUTES: Array<{ re: RegExp; template: string }> = [
    { re: /^\/blog\/[^/]+$/, template: "/blog/:slug" },
    { re: /^\/market\/items\/[^/]+$/, template: "/market/items/:itemId" },
    { re: /^\/market\/orders\/[^/]+$/, template: "/market/orders/:id" },
    { re: /^\/market\/players\/[^/]+$/, template: "/market/players/:uid" },
];

const REDIRECT_MAP: Record<string, string> = {
    "/singleplayer": "/singleplayer/extract",
    "/multiplayer": "/multiplayer/tops-map",
    "/manage": "/manage/api-keys",
    "/rarity": "/rarity/rocks",
};

// A path segment that looks like a volatile identifier rather than a stable
// route name: pure numbers, UUIDs, or long hex/hash-like tokens. These get
// collapsed to ``:id`` in the generic fallback so an unlisted dynamic route
// can't explode the ``metadata->>'path'`` cardinality.
const ID_SEGMENT_RE =
    /^(?:\d+|[0-9a-fA-F]{8,}|[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,})$/;

// Upper bound on how much of an unknown path we keep, so a deeply nested or
// hostile URL can't produce an unbounded template.
const MAX_FALLBACK_SEGMENTS = 4;
const MAX_SEGMENT_LEN = 32;

/**
 * Best-effort template for a path we don't explicitly know about. Keeps the
 * static segments (lower-cased) but replaces anything that looks like a
 * per-record identifier with ``:id`` and caps the depth. Returns
 * ``/unknown`` only when there's nothing usable left.
 */
function genericTemplate(p: string): string {
    const segments = p.split("/").filter(Boolean).slice(0, MAX_FALLBACK_SEGMENTS);
    if (segments.length === 0) return "/unknown";
    const cleaned = segments.map((s) =>
        ID_SEGMENT_RE.test(s) || s.length > MAX_SEGMENT_LEN ? ":id" : s.toLowerCase(),
    );
    return "/" + cleaned.join("/");
}

/**
 * Map a raw `location.pathname` to one of the registered route templates.
 * Strips trailing slashes, ignores query strings & hashes, and normalizes
 * unlisted paths through :func:`genericTemplate` so the server only ever
 * sees a bounded set of values.
 */
export function normalizePath(pathname: string): string {
    if (!pathname) return "/unknown";
    let p = pathname.split("?")[0].split("#")[0];
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    if (REDIRECT_MAP[p]) p = REDIRECT_MAP[p];
    if (KNOWN_ROUTES.includes(p)) return p;
    for (const { re, template } of DYNAMIC_ROUTES) {
        if (re.test(p)) return template;
    }
    return genericTemplate(p);
}

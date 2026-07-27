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

// Routes that opt into per-entity analytics: the raw id after the template
// prefix is captured as a ``ref`` so the admin "Items & Players" tab can rank
// individual entities. The capture group holds the id. Keep the template
// strings in sync with ``_ENTITY_PATHS`` in the backend ``admin_usage.py``.
const REF_ROUTES: Array<{ re: RegExp; template: string }> = [
    { re: /^\/market\/items\/([^/]+)$/, template: "/market/items/:itemId" },
    { re: /^\/market\/players\/([^/]+)$/, template: "/market/players/:uid" },
];

// A ref must satisfy the server-side ``_REF_RE``. The charset covers base64
// (VS player uids are base64 and contain ``+`` / ``/`` / ``=``) plus common id
// punctuation. Ids with characters outside this set are simply not attributed
// — the view still counts under the template, it just isn't ranked per-entity.
const REF_SAFE_RE = /^[A-Za-z0-9:_.+/=-]{1,64}$/;

export interface PathDescriptor {
    /** Bounded-cardinality route template, e.g. ``/market/items/:itemId``. */
    template: string;
    /** Raw entity id for ref-enabled routes, when present and URL-safe. */
    ref?: string;
}

/**
 * Like :func:`normalizePath` but also extracts the raw entity id for
 * ref-enabled routes so per-entity analytics can rank individual items /
 * player profiles without exploding the ``metadata->>'path'`` cardinality.
 */
export function describePath(pathname: string): PathDescriptor {
    if (!pathname) return { template: "/unknown" };
    let p = pathname.split("?")[0].split("#")[0];
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    for (const { re, template } of REF_ROUTES) {
        const m = re.exec(p);
        if (m) {
            let raw = m[1];
            try {
                raw = decodeURIComponent(raw);
            } catch {
                /* leave raw as-is if it isn't valid percent-encoding */
            }
            return REF_SAFE_RE.test(raw) ? { template, ref: raw } : { template };
        }
    }
    return { template: normalizePath(p) };
}

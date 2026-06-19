/**
 * Client-side route normalization for the admin Usage "Pages" analytics.
 *
 * We send a short, fixed-cardinality template (e.g. ``/blog/:slug``) to the
 * server instead of the raw pathname, so the ``metadata->>'path'`` index
 * stays small no matter how many slugs / ids exist. The whitelist below
 * mirrors the React Router routes declared in ``AppContent.tsx``; any
 * unknown path collapses to ``/unknown`` so it can't blow up cardinality.
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
    "/tools",
    "/tools/waypoints",
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
];

const REDIRECT_MAP: Record<string, string> = {
    "/singleplayer": "/singleplayer/extract",
    "/multiplayer": "/multiplayer/tops-map",
    "/manage": "/manage/api-keys",
};

/**
 * Map a raw `location.pathname` to one of the registered route templates.
 * Strips trailing slashes, ignores query strings & hashes, and clamps the
 * output to the whitelist so the server only ever sees a known small set
 * of values.
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
    return "/unknown";
}

/**
 * Per-route SEO metadata. The app applies it to <head> on every navigation
 * (see components/seo/RouteSeo.tsx) and the build uses it to write
 * sitemap.xml plus a static index.html per route, so crawlers and link
 * previews that don't run JavaScript still get the right title, description
 * and canonical URL (see plugins/seo.ts).
 *
 * Keep this module free of browser and React imports: vite.config.ts loads it.
 */

export const SITE_URL = "https://the-cairn.com";
export const SITE_NAME = "Cairn";

export interface PageSeo {
  /** Page title without the site name; it's appended by formatTitle(). */
  title: string;
  description: string;
  /** Keep the page out of search results and the sitemap. */
  noindex?: boolean;
  /** For a route that duplicates another one: the path to use as its canonical URL. */
  canonicalPath?: string;
}

/** Used for the root index.html, which is served for `/` and every route without its own file. */
export const DEFAULT_SEO: PageSeo = {
  title: "Cairn – Vintage Story Interactive Map, Translocator Planner & Waypoint Tools",
  description:
    "Free community toolkit for Vintage Story: explore the TOPS server map with translocators, traders and landmarks, plan routes, track auction house prices and manage your waypoints.",
};

const CONTRIBUTE_MAP_SEO: PageSeo = {
  title: "Contribute Your Map to the TOPS Server Map",
  description:
    "Upload your Vintage Story map cache to help build and refine the shared community map of the TOPS server.",
};

/** Static routes, keyed by path. Keep in sync with <Routes> in components/AppContent.tsx. */
export const PAGE_SEO: Record<string, PageSeo> = {
  "/general": DEFAULT_SEO,
  "/multiplayer/tops-map": {
    title: "TOPS Server Map for Vintage Story – Translocators & Traders",
    description:
      "Interactive TOPS server map for Vintage Story built from player contributions: translocators, traders, landmarks, player claims, oceans, rock strata and climate, plus a route planner.",
  },
  "/multiplayer/contribute-map": CONTRIBUTE_MAP_SEO,
  "/multiplayer/contribute": {
    ...CONTRIBUTE_MAP_SEO,
    canonicalPath: "/multiplayer/contribute-map",
  },
  "/multiplayer/contribute-tls": {
    title: "Contribute Translocators to the TOPS Map",
    description:
      "Submit Vintage Story translocator pairs to the shared TOPS map so everyone's route planner can travel through them.",
  },
  "/multiplayer/contribute-traders": {
    title: "Contribute Traders",
    description: "Submit Vintage Story trader locations to the shared TOPS map.",
    noindex: true,
  },
  "/multiplayer/identify": {
    title: "Identify Map Databases",
    description:
      "Match your Vintage Story multiplayer map files to the servers they belong to by analyzing your game logs.",
    noindex: true,
  },
  "/multiplayer/map-viewer": {
    title: "Local Map Viewer",
    description: "Render and explore a cached Vintage Story map .db file as an interactive image.",
    noindex: true,
  },
  "/singleplayer/extract": {
    title: "Extract Waypoints from a Vintage Story Save",
    description:
      "Pull every waypoint out of your Vintage Story .vcdbs save file into JSON. The file is processed in memory and never stored.",
  },
  "/singleplayer/import": {
    title: "Import Waypoints into a Vintage Story Save",
    description:
      "Write waypoints back into a Vintage Story .vcdbs save file, appending to or replacing the existing ones.",
  },
  "/singleplayer/commands": {
    title: "Vintage Story Waypoint Command Generator",
    description:
      "Turn a JSON list of waypoints into /waypoint addati chat commands you can paste into Vintage Story.",
  },
  "/singleplayer/delete": {
    title: "Delete Waypoints from a Vintage Story Save",
    description:
      "Remove matching waypoints from a Vintage Story .vcdbs save file by name, icon or colour.",
  },
  "/market": {
    title: "Vintage Story Auction House Prices & Market Trends",
    description:
      "Track the TOPS auction house for Vintage Story: market trends, most traded items, price history, inflation and wealth statistics from recorded auctions.",
  },
  "/market/listings": {
    title: "Auction House Listings – Vintage Story TOPS",
    description:
      "Search and filter recorded Vintage Story TOPS auction house listings by item, category, status, price, seller and buyer.",
  },
  "/market/items": {
    title: "Vintage Story Item Prices – Auction House Item Search",
    description:
      "Look up any Vintage Story item traded on the TOPS auction house and see its typical price, sales volume and price history.",
  },
  "/market/price-index": {
    title: "Auction House Price Index & Inflation – Vintage Story",
    description:
      "Follow inflation on the Vintage Story TOPS auction house with a price index, biweekly trend and per-category breakdown.",
  },
  "/market/insights": {
    title: "Auction House Market Insights – Vintage Story",
    description:
      "Derived indicators for every item on the Vintage Story TOPS auction house, such as price volatility, seller concentration and time to sell.",
  },
  "/market/converter": {
    title: "Vintage Story Item Value Converter",
    description:
      "Estimate what your Vintage Story items barter for using TOPS auction house prices in rusty gears, with a low, typical and high estimate.",
  },
  "/market/orders": {
    title: "Buy & Sell Orders – Vintage Story TOPS",
    description:
      "Community buy and sell orders for the Vintage Story TOPS server: post what you have or want and negotiate directly with other players.",
  },
  "/market/leaderboards": {
    title: "Auction House Leaderboards – Vintage Story TOPS",
    description:
      "Top sellers, top buyers, most valuable items and biggest single sales on the Vintage Story TOPS auction house.",
  },
  "/market/players": {
    title: "Auction House Player Search – Vintage Story TOPS",
    description:
      "Search traders seen on the Vintage Story TOPS auction house and open their trading profile: pricing style, favourite items and trade locations.",
  },
  "/market/map": {
    title: "Auction House Trade Map – Vintage Story TOPS",
    description: "See where auction house trades happen across the Vintage Story TOPS server map.",
  },
  "/rarity/rocks": {
    title: "Vintage Story Rock Rarity & Pricing",
    description:
      "Estimate how rare each Vintage Story rock and its aged variants are on the TOPS map, and turn that rarity into suggested prices.",
  },
  "/rarity/loot-pools": {
    title: "Vintage Story Loot Pools & Drop Chances",
    description:
      "Every weighted loot pool in Vintage Story (ruins, story structures, abandoned mines, cracked vessels and fishing junk) and how likely each item is to drop.",
  },
  "/tools": {
    title: "Vintage Story Tunnel & Road Builder",
    description:
      "Plan an efficient tunnel between two points in Vintage Story: pick a tunnel pattern or custom step ratios for a staircase that's easy to dig.",
  },
  "/tools/waypoints": {
    title: "Vintage Story Waypoint Macro Generator",
    description:
      "Build a Vintage Story macro of /waypoint commands from your client-chat.log, imported map markers or from scratch, then download the macro file.",
  },
  "/tools/alloy-calculator": {
    title: "Vintage Story Alloy Calculator",
    description:
      "Work out the exact metal units needed for bronze, brass and other Vintage Story alloys. Embeds the calculator from vintagecalc.eu.",
  },
  "/tools/charcoal-calculator": {
    title: "Vintage Story Charcoal Pit Calculator",
    description:
      "Calculate how much charcoal a Vintage Story charcoal pit produces. Embeds the calculator from vintagecalc.eu.",
  },
  "/public/road-workers": {
    title: "Road Workers – Saved Routes",
    description:
      "Aggregated, anonymous routes saved by players in the route planner, to help prioritise tunnels, signage and shortcuts.",
    noindex: true,
  },
  "/blog": {
    title: "Vintage Story TOPS Map Guides",
    description:
      "Guides for the Vintage Story TOPS map: contributing map data, adding translocators and landmarks, elk-walkable roads and more.",
  },
  "/privacy": {
    title: "Privacy Policy",
    description:
      "How Cairn handles your data: uploaded files, accounts, API keys, cookies, retention and your rights.",
  },
  "/terms": {
    title: "Terms of Use",
    description:
      "The terms for using Cairn, an unofficial Vintage Story fan project: API keys, acceptable use, contributions, donations and more.",
  },
  "/account": {
    title: "My Account",
    description: "Manage your Cairn profile, API key and personal data.",
    noindex: true,
  },
  "/preferences": {
    title: "Preferences",
    description: "Customize how the Cairn map and site look.",
    noindex: true,
  },
};

/** Admin and token-only areas: never indexed. */
const PRIVATE_PREFIXES = ["/manage", "/audit", "/usage", "/download"];

const PRIVATE_SEO: PageSeo = { ...DEFAULT_SEO, title: SITE_NAME, noindex: true };

export function normalizePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

/**
 * SEO for a static or private route, or null for dynamic routes (blog posts,
 * market items, ...) and unknown paths, whose pages set their own.
 */
export function getRouteSeo(pathname: string): PageSeo | null {
  const path = normalizePath(pathname);
  if (Object.hasOwn(PAGE_SEO, path)) return PAGE_SEO[path];
  if (PRIVATE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return PRIVATE_SEO;
  return null;
}

export function formatTitle(title: string): string {
  return title.startsWith(SITE_NAME) ? title : `${title} | ${SITE_NAME}`;
}

export type HeadTag =
  | { tag: "title"; text: string }
  | { tag: "meta"; attr: "name" | "property"; key: string; content: string }
  | { tag: "link"; rel: string; href: string };

/**
 * The route-specific <head> tags. `path` is the page's own path, or null for
 * HTML that is served for many URLs and so must not claim a canonical URL.
 */
export function getHeadTags(seo: PageSeo, path: string | null): HeadTag[] {
  const tags: HeadTag[] = [
    { tag: "title", text: formatTitle(seo.title) },
    { tag: "meta", attr: "name", key: "description", content: seo.description },
    { tag: "meta", attr: "property", key: "og:title", content: seo.title },
    { tag: "meta", attr: "property", key: "og:description", content: seo.description },
    { tag: "meta", attr: "name", key: "twitter:title", content: seo.title },
    { tag: "meta", attr: "name", key: "twitter:description", content: seo.description },
  ];
  if (seo.noindex) {
    tags.push({ tag: "meta", attr: "name", key: "robots", content: "noindex" });
  } else if (path !== null) {
    const url = SITE_URL + (seo.canonicalPath ?? path);
    tags.push({ tag: "link", rel: "canonical", href: url });
    tags.push({ tag: "meta", attr: "property", key: "og:url", content: url });
  }
  return tags;
}

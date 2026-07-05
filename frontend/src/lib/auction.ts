// Data access for the Auction House explorer.
//
// The market data is produced offline by `backend/process_auction_data.py`
// and published to the public R2 bucket (`… --publish-r2`) as static JSON
// under `auction/`. When `VITE_PUBLIC_BUCKET_ORIGIN` is set we fetch it from
// R2 at runtime (no commit/redeploy needed to refresh the market); otherwise
// we fall back to the committed static bundle under `public/auction/` for
// local dev. Fetches are cached via TanStack Query + the browser HTTP cache.
//
// Cache invalidation: the R2 data files are uploaded `immutable`, so we bust
// their cache by appending `?v=<version>` read from `manifest.json` (uploaded
// `no-cache`). A republish flips the version → every data URL changes → old
// cached copies are dropped instantly.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
    AuctionListing,
    AuctionSummary,
    ItemCatalog,
} from "@/models/auction";

const publicBucketOrigin = import.meta.env.VITE_PUBLIC_BUCKET_ORIGIN?.replace(/\/+$/, "");
// When the public bucket origin is configured, fetch the market data straight
// from R2. Otherwise fall back to the committed static bundle for local dev.
const USE_R2 = Boolean(publicBucketOrigin);
const AUCTION_BASE = USE_R2
    ? `${publicBucketOrigin}/auction`
    : `${import.meta.env.BASE_URL}auction`;

interface AuctionManifest {
    version: string;
    generatedUtc?: string;
    files?: string[];
}

async function fetchManifest(signal?: AbortSignal): Promise<AuctionManifest> {
    // `no-store`: always read the freshest pointer. The data files it names are
    // the ones that get cached hard (they're content-versioned via `?v=`).
    const res = await fetch(`${AUCTION_BASE}/manifest.json`, { signal, cache: "no-store" });
    if (!res.ok) {
        throw new Error(`Failed to load auction manifest: ${res.status}`);
    }
    return (await res.json()) as AuctionManifest;
}

/** Fetch the R2 dataset pointer. Re-checked every minute so a republish is
 *  picked up without a page reload. Disabled (never runs) in the static
 *  bundle fallback where there is no manifest. */
export function useAuctionManifest() {
    return useQuery({
        queryKey: ["auction", "manifest"],
        queryFn: ({ signal }) => fetchManifest(signal),
        enabled: USE_R2,
        staleTime: 1000 * 60, // re-check the pointer every minute
        gcTime: 1000 * 60 * 60,
        refetchOnWindowFocus: false,
    });
}

/** Current dataset version + whether the data queries may run yet.
 *  In static-bundle mode (`!USE_R2`) there is no version and queries run
 *  immediately. In R2 mode we wait for the manifest to settle; if it errors we
 *  still proceed (unversioned URL) so the explorer degrades gracefully. */
function useAuctionVersion(): { ready: boolean; version?: string } {
    const manifest = useAuctionManifest();
    if (!USE_R2) return { ready: true, version: undefined };
    if (manifest.isPending) return { ready: false, version: undefined };
    return { ready: true, version: manifest.data?.version };
}

function auctionUrl(path: string, version?: string): string {
    return version ? `${AUCTION_BASE}/${path}?v=${version}` : `${AUCTION_BASE}/${path}`;
}

/** URL for the raw auctions CSV, cache-busted by the current version. Points at
 *  the R2 bucket's `auction/` folder when a public bucket origin is configured,
 *  and at the committed `public/auction/` bundle for local dev. Returns
 *  `undefined` while the manifest (and thus the version) is still loading. */
export function useAuctionCsvUrl(): string | undefined {
    const { ready, version } = useAuctionVersion();
    if (!ready) return undefined;
    return auctionUrl("auctions.csv", version);
}

async function fetchJson<T>(path: string, version?: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(auctionUrl(path, version), { signal });
    if (!res.ok) {
        throw new Error(`Failed to load ${path}: ${res.status}`);
    }
    return (await res.json()) as T;
}

// Market data is static per deploy/refresh — cache aggressively.
const STATIC_QUERY = {
    staleTime: 1000 * 60 * 60, // 1h
    gcTime: 1000 * 60 * 60 * 24,
    refetchOnWindowFocus: false,
    meta: { persist: true },
} as const;

export function useAuctionListings() {
    const { ready, version } = useAuctionVersion();
    return useQuery({
        queryKey: ["auction", "listings", version],
        queryFn: async ({ signal }) => {
            const data = await fetchJson<AuctionListing[]>("listings.json", version, signal);
            refreshMarketReferences(data);
            return data;
        },
        enabled: ready,
        ...STATIC_QUERY,
        // The listings payload is ~13 MB — far larger than the localStorage
        // quota — so it must NOT be dehydrated into storage (attempting to
        // serialise it on every cache change is slow and throws QuotaExceeded).
        // The in-memory cache + the browser's HTTP cache already make reloads
        // fast; only the small summary/items artifacts opt into persistence.
        meta: undefined,
    });
}

export function useAuctionSummary(options?: { enabled?: boolean }) {
    const { ready, version } = useAuctionVersion();
    return useQuery({
        queryKey: ["auction", "summary", version],
        queryFn: ({ signal }) => fetchJson<AuctionSummary>("summary.json", version, signal),
        enabled: ready && (options?.enabled ?? true),
        ...STATIC_QUERY,
    });
}

export function useItemCatalog() {
    const { ready, version } = useAuctionVersion();
    return useQuery({
        queryKey: ["auction", "items", version],
        queryFn: ({ signal }) => fetchJson<ItemCatalog>("items.json", version, signal),
        enabled: ready,
        ...STATIC_QUERY,
    });
}

/** Format a Rusty Gears amount for display. */
export function formatGears(n: number): string {
    if (n < 1) return `${n.toFixed(2)}⚙`;
    return `${Math.round(n).toLocaleString()}⚙`;
}

/**
 * Label for a single listing row. Clutter items are grouped under a base item
 * (e.g. "Toy"), but an individual listing shows its exact variant (e.g. "toy7")
 * so the specific object is visible on the board. Non-clutter listings fall back
 * to the item name.
 */
export function listingLabel(l: { variant?: string | null; name: string }): string {
    return l.variant || l.name;
}

/**
 * Group base for a clutter/tapestry variant code: the `type` with any trailing
 * number stripped (e.g. "toy7" -> "toy", "ambush3" -> "ambush",
 * "rotbeast11" -> "rotbeast"). Mirrors the backend's `_variant_base`.
 */
export function variantBase(variant: string): string {
    return variant.replace(/\d+$/, "").replace(/[-_/]+$/, "") || variant;
}

/**
 * Vintage Story host rocks that ore blocks are embedded in. The same ore in a
 * different stratum is a distinct block id (e.g. `ore-bountiful-hematite-granite`
 * vs `…-peridotite`) but is functionally the same tradeable item, so we treat
 * the trailing rock segment as a variant to merge on the item page.
 */
const ORE_HOST_ROCKS = new Set([
    "granite",
    "andesite",
    "basalt",
    "peridotite",
    "diorite",
    "gabbro",
    "gneiss",
    "sandstone",
    "limestone",
    "conglomerate",
    "chalk",
    "claystone",
    "shale",
    "slate",
    "chert",
    "phyllite",
    "quartzite",
    "sanidine",
    "suevite",
    "marble",
    "halite",
    "kimberlite",
    "obsidian",
]);

/**
 * Split an ore item code into its host-rock-agnostic base and the host rock.
 * e.g. `ore-bountiful-hematite-granite` -> `{ base: "ore-bountiful-hematite",
 * rock: "granite" }`. Codes without a recognised trailing rock (e.g.
 * `ore-quartz`, `ore-borax`) return the code unchanged with `rock: null`, so an
 * ore that exists in one form only never merges with anything else.
 */
export function splitOreHostRock(code: string): { base: string; rock: string | null } {
    const tail = code.includes(":") ? (code.split(":").pop() as string) : code;
    const parts = tail.split("-");
    if (parts.length >= 3 && ORE_HOST_ROCKS.has(parts[parts.length - 1])) {
        const rock = parts.pop() as string;
        return { base: parts.join("-"), rock };
    }
    return { base: tail, rock: null };
}

/**
 * Turn a bare item/block code into a readable display name, mirroring the
 * backend's `humanize_code` (used to label an ore group merged across host
 * rocks, e.g. `ore-bountiful-hematite` -> "Ore bountiful hematite").
 */
export function humanizeItemCode(code: string): string {
    const tail = code.includes(":") ? (code.split(":").pop() as string) : code;
    const words = tail.replace(/_/g, "-").split("-").filter(Boolean);
    if (words.length === 0) return code;
    const text = words.join(" ");
    return text.slice(0, 1).toUpperCase() + text.slice(1);
}

/**
 * Material families that group the different in-game *forms* of the same
 * underlying material, so the item page can surface "Related items" the way the
 * survival handbook chains an ore to its metal. Examples:
 *   * hematite / magnetite / limonite ore → iron nugget → iron bloom → iron ingot
 *   * sulfur chunk → powdered sulfur
 *   * rock salt (halite) → salt
 * `tokens` are matched as *whole words* against an item's code segments and its
 * display name, so "salt" never swallows "saltpeter" (a distinct family).
 */
interface MaterialFamily {
    key: string;
    label: string;
    tokens: string[];
}

const MATERIAL_FAMILIES: MaterialFamily[] = [
    // Metals: the ore minerals that smelt into a metal share the metal's family,
    // even though their codes/names don't mention the metal (e.g. "hematite").
    { key: "iron", label: "Iron", tokens: ["iron", "ironbloom", "hematite", "magnetite", "limonite"] },
    { key: "copper", label: "Copper", tokens: ["copper", "nativecopper", "malachite", "cuprite", "tetrahedrite"] },
    { key: "tin", label: "Tin", tokens: ["tin", "cassiterite"] },
    { key: "zinc", label: "Zinc", tokens: ["zinc", "sphalerite"] },
    { key: "lead", label: "Lead", tokens: ["lead", "galena"] },
    { key: "silver", label: "Silver", tokens: ["silver"] },
    { key: "gold", label: "Gold", tokens: ["gold", "nativegold"] },
    { key: "bismuth", label: "Bismuth", tokens: ["bismuth", "bismuthinite"] },
    { key: "titanium", label: "Titanium", tokens: ["titanium", "ilmenite"] },
    { key: "chromium", label: "Chromium", tokens: ["chromium", "chromite"] },
    { key: "nickel", label: "Nickel", tokens: ["nickel", "pentlandite"] },
    { key: "platinum", label: "Platinum", tokens: ["platinum"] },
    // Minerals / non-metals: the raw chunk and its processed forms (powder, etc.).
    { key: "sulfur", label: "Sulfur", tokens: ["sulfur", "sulphur"] },
    { key: "salt", label: "Salt", tokens: ["salt", "halite"] },
    { key: "saltpeter", label: "Saltpeter", tokens: ["saltpeter", "saltpetre", "niter", "nitre"] },
    { key: "borax", label: "Borax", tokens: ["borax"] },
    { key: "quartz", label: "Quartz", tokens: ["quartz"] },
    { key: "cinnabar", label: "Cinnabar", tokens: ["cinnabar", "mercury", "quicksilver"] },
    { key: "fluorite", label: "Fluorite", tokens: ["fluorite"] },
    { key: "lapislazuli", label: "Lapis lazuli", tokens: ["lapislazuli", "lazurite"] },
    { key: "olivine", label: "Olivine", tokens: ["olivine", "peridot"] },
    { key: "sylvite", label: "Sylvite", tokens: ["sylvite", "potash"] },
    { key: "graphite", label: "Graphite", tokens: ["graphite"] },
    { key: "corundum", label: "Corundum", tokens: ["corundum", "ruby", "sapphire"] },
    { key: "diamond", label: "Diamond", tokens: ["diamond"] },
];

/**
 * Item categories (the first code segment, e.g. "ore-bountiful-hematite" ->
 * "ore") that count as a raw/intermediate *material form* for the "Related
 * items" section. This keeps the related list to the material chain (ore →
 * nugget → bloom → ingot, chunk → powder) and excludes finished goods that merely
 * share a metal name (e.g. an iron pickaxe or anvil).
 */
const RELATED_FORM_CATEGORIES = new Set([
    "ore",
    "nugget",
    "ingot",
    "ironbloom",
    "crystal",
    "powder",
    "gem",
    "metalbit",
    // Raw mineral rock/stone forms (e.g. "stone-halite" = rock salt, "rock-halite").
    // Scoped by the material-family filter, so only family-matching stones/rocks
    // (not granite, basalt, …) ever surface as related.
    "stone",
    "rock",
    // Raw minerals whose category *is* the mineral name.
    "sulfur",
    "sulphur",
    "salt",
    "halite",
    "saltpeter",
    "borax",
    "quartz",
    "cinnabar",
    "fluorite",
    "graphite",
]);

/** Split an item code + name into the set of whole lowercase words it contains. */
function itemWordTokens(entry: { code: string | null; name: string }): Set<string> {
    const words = new Set<string>();
    if (entry.code) {
        // Strip an ore's trailing host-rock segment (e.g. `ore-sylvite-halite` ->
        // `ore-sylvite`) so the rock stratum an ore is embedded in can't leak a
        // false material token — e.g. sylvite mined in halite rock must not join
        // the salt/halite family.
        const base = splitOreHostRock(entry.code).base;
        for (const w of base.toLowerCase().split(/[-_/]+/)) if (w) words.add(w);
    }
    for (const w of entry.name.toLowerCase().split(/[^a-z0-9]+/)) if (w) words.add(w);
    return words;
}

/**
 * Resolve an item to its {@link MaterialFamily} (e.g. an iron ore, nugget, bloom
 * and ingot all resolve to `iron`), or `null` when it belongs to no known
 * material family. Used to link between different forms of the same material.
 */
export function resolveItemFamily(entry: {
    code: string | null;
    name: string;
}): { key: string; label: string } | null {
    const words = itemWordTokens(entry);
    for (const fam of MATERIAL_FAMILIES) {
        if (fam.tokens.some((t) => words.has(t))) return { key: fam.key, label: fam.label };
    }
    return null;
}

/** Whether an item's category is a raw/intermediate material form (see above). */
export function isRelatedFormCategory(category: string): boolean {
    return RELATED_FORM_CATEGORIES.has(category);
}

// --------------------------------------------------------------------------- //
// Manual "Related items" links
// --------------------------------------------------------------------------- //
/**
 * Hand-crafted "Related items" links, layered on top of the automatic material
 * families above. Use these for relationships the token families can't express
 * on their own — e.g. an alloy that draws from several base metals, or a link to
 * a couple of *specific* items without pulling in their whole family.
 *
 * A rule matches the item you're viewing by its `code`, then contributes extra
 * related items via any combination of:
 *   • `families` — pull in every related-form member of these material families
 *     (keys from {@link MATERIAL_FAMILIES}, e.g. "lead", "tin"). This is ON TOP
 *     of the item's own auto-detected family, so you only list the *extra* ones.
 *   • `items`    — pull in these exact item *codes*, regardless of their family
 *     or category. Use this to link a few specific items without dragging in
 *     their whole family.
 *
 * Code matching (for both `code` and `items`): exact match, or a trailing `*`
 * for a prefix match (e.g. `"ore-sylvite*"` matches `ore-sylvite` and
 * `ore-sylvite-halite`). A leading `game:` (or any `domain:`) is ignored.
 *
 * Links are one-directional: a rule only affects the page whose item matches
 * `code`. To relate two items *both* ways, add a rule on each side.
 *
 * ── HOW TO ADD A LINK ──────────────────────────────────────────────────────
 * Add an object to {@link MANUAL_LINKS}. Example — "Lead solder ingot" should
 * relate to the whole lead + tin chains, plus the two silver-solder items
 * specifically, but NOT the rest of the silver family:
 *
 *   { code: "ingot-leadsolder",
 *     label: "Solder & its base metals",
 *     families: ["lead", "tin"],
 *     items: ["ingot-silversolder", "metalbit-silversolder"] },
 *
 * (Its own "lead" family is already included automatically, so `families` here
 * only needs the *additional* "tin". It's listed anyway for clarity — harmless.)
 */
export interface ManualLinkRule {
    /** Item code of the page this rule applies to (exact, or `"prefix*"`). */
    code: string;
    /** Optional heading shown under "Related items" (defaults to the family). */
    label?: string;
    /** Extra material-family keys to include (from {@link MATERIAL_FAMILIES}). */
    families?: string[];
    /** Extra item codes to include verbatim (exact, or `"prefix*"`). */
    items?: string[];
}

const MANUAL_LINKS: ManualLinkRule[] = [
    // ── Add your hand-crafted links here. See the docs above for the format. ──
    // {
    //     code: "ingot-leadsolder",
    //     label: "Solder & its base metals",
    //     families: ["lead", "tin"],
    //     items: ["ingot-silversolder", "metalbit-silversolder"],
    // },
];

/** Strip a leading `domain:` (e.g. `game:`) from an item code for matching. */
function bareCode(code: string): string {
    return code.includes(":") ? (code.split(":").pop() as string) : code;
}

/** Match an item code against a pattern — exact, or a trailing `*` for prefix. */
function codeMatches(code: string, pattern: string): boolean {
    const c = bareCode(code);
    const p = bareCode(pattern);
    if (p.endsWith("*")) return c.startsWith(p.slice(0, -1));
    return c === p;
}

/** The first manual-link rule whose `code` matches this item, or null. */
function findManualLink(code: string | null): ManualLinkRule | null {
    if (!code) return null;
    return MANUAL_LINKS.find((r) => codeMatches(code, r.code)) ?? null;
}

/** A related item surfaced on the item page. */
export interface RelatedItem {
    id: number;
    name: string;
    category: string;
}

export interface RelatedItems {
    /** Heading shown next to "Related items" (e.g. "Other forms of iron"). */
    label: string;
    items: RelatedItem[];
}

/**
 * Compute the "Related items" for an item page: the other in-game *forms* of the
 * same underlying material (ore → nugget → bloom → ingot, chunk → powder, …),
 * plus any hand-crafted links from {@link MANUAL_LINKS}.
 *
 * Membership comes from three sources, unioned together:
 *   1. The item's own material family (auto-detected from its code/name).
 *   2. Any extra `families` a matching manual rule adds.
 *   3. Any specific `items` codes a matching manual rule adds (family-agnostic).
 * Family members are restricted to raw/intermediate *forms* (so a finished tool
 * that merely shares a metal name doesn't show up); manual `items` are not.
 *
 * @param selfIds  itemIds already represented by this page (a merged ore
 *                 host-rock group, or just the current item) — never "related".
 * @param activeIds itemIds that actually have listings, so links land on a page
 *                 with data. Pass an empty set to skip this filter.
 */
export function computeRelatedItems(
    currentId: number,
    catalog: ItemCatalog,
    selfIds: Set<number>,
    activeIds: Set<number>,
): RelatedItems | null {
    const current = catalog[String(currentId)];
    if (!current) return null;

    const ownFamily = resolveItemFamily(current);
    const rule = findManualLink(current.code);
    if (!ownFamily && !rule) return null;

    // Families to draw related *forms* from: the item's own, plus manual extras.
    const familyKeys = new Set<string>();
    if (ownFamily) familyKeys.add(ownFamily.key);
    for (const k of rule?.families ?? []) familyKeys.add(k);
    // Specific item codes a manual rule links regardless of family/category.
    const itemPatterns = rule?.items ?? [];

    const filterActive = activeIds.size > 0;
    const seen = new Set<string>();
    const items: RelatedItem[] = [];
    for (const [key, e] of Object.entries(catalog)) {
        const iid = Number(key);
        if (selfIds.has(iid)) continue;
        if (filterActive && !activeIds.has(iid)) continue;

        // Include if the entry is a form-member of an included family, OR it's
        // one of the manually-listed specific item codes.
        const byFamily =
            isRelatedFormCategory(e.category) &&
            (() => {
                const ef = resolveItemFamily(e);
                return ef != null && familyKeys.has(ef.key);
            })();
        const byManualItem = e.code != null && itemPatterns.some((p) => codeMatches(e.code!, p));
        if (!byFamily && !byManualItem) continue;

        // Collapse an ore's host-rock variants (distinct block ids) into one
        // entry; any one id opens the item page, which re-merges the strata.
        let dedupe: string;
        let name: string;
        if (e.category === "ore" && e.code) {
            const b = splitOreHostRock(e.code).base;
            dedupe = `ore:${b}`;
            name = humanizeItemCode(b);
        } else {
            dedupe = e.code ?? e.name;
            name = e.name;
        }
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        items.push({ id: iid, name, category: e.category });
    }
    if (items.length === 0) return null;
    items.sort((a, b) => a.name.localeCompare(b.name));

    const label =
        rule?.label ??
        (ownFamily ? `Other forms of ${ownFamily.label.toLowerCase()}` : `Related to ${current.name}`);
    return { label, items };
}

/**
 * Whether a listing carries written content — a parchment (or book) someone
 * wrote a story, note, or advert on. Such items are priced for their content,
 * not as the raw commodity, so they must be excluded from fair-price
 * aggregation (median / percentiles / trend) even though they're still shown in
 * the listing tables. Detected from the item stack's `text` / `title` attrs.
 */
export function listingHasText(l: { attrs?: Record<string, unknown> | null }): boolean {
    const a = l.attrs;
    if (!a) return false;
    const text = typeof a.text === "string" ? a.text.trim() : "";
    const title = typeof a.title === "string" ? a.title.trim() : "";
    return text.length > 0 || title.length > 0;
}

/** Linear-interpolated percentile over an already-sorted ascending array. */
export function percentileSorted(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Convert an in-game "hours to sell" figure into real-world elapsed time.
 * Vintage Story runs at 1 in-game hour ≈ 2 real minutes, so real minutes =
 * gameHours * 2. The result is formatted into the largest sensible unit.
 */
export function formatRealTimeToSell(gameHours: number): string {
    const realMinutes = gameHours * 2;
    if (realMinutes < 1) return "<1 min";
    if (realMinutes < 60) return `${Math.round(realMinutes)} min`;
    const realHours = realMinutes / 60;
    if (realHours < 24) {
        const h = Math.floor(realHours);
        const m = Math.round(realMinutes - h * 60);
        return m ? `${h} h ${m} min` : `${h} h`;
    }
    const days = realHours / 24;
    const d = Math.floor(days);
    const h = Math.round(realHours - d * 24);
    return h ? `${d} d ${h} h` : `${d} d`;
}

// --------------------------------------------------------------------------- //
// Market reference clocks
// --------------------------------------------------------------------------- //
// The dataset is a static snapshot, so two reference points are derived once
// per load and cached module-side (cheap to read from the per-row badge):
//
//  * currentGameHours — an auction is posted at ~the current in-game moment, so
//    the highest `postedTotalHours` across all listings is our best estimate of
//    "now" in-game. Only ever moves forward.
//  * latestObservedUtc — every capture pass stamps all auctions still on the
//    board with the same `lastObservedUtc`, so the maximum value marks the most
//    recent sweep of the live Auction House. A listing whose last observation
//    predates it dropped off the board (sold/expired/removed) and is no longer
//    visible in-game.

let cachedCurrentGameHours = 0;
let cachedLatestObservedUtc = "";
let cachedLatestSweepStartMs = 0;

// A single capture sweep stamps every still-listed auction with ~the same
// `lastObservedUtc`, but writing hundreds of rows takes a few seconds, so the
// timestamps within one sweep are close but not identical. Consecutive stamps
// that fall within this window belong to the same sweep; a larger gap marks the
// boundary to an earlier capture pass (which are minutes/hours apart). This lets
// us treat a whole sweep — not just the single newest row — as "still on board".
const SWEEP_GAP_MS = 10 * 60 * 1000; // 10 minutes

/** Earliest observation timestamp (epoch ms) that still belongs to the most
 * recent capture sweep, derived by walking distinct timestamps newest-first and
 * stopping at the first gap larger than a single sweep's write span. */
function computeLatestSweepStartMs(observedMs: number[]): number {
    if (!observedMs.length) return cachedLatestSweepStartMs;
    const distinct = Array.from(new Set(observedMs)).sort((a, b) => b - a);
    let start = distinct[0];
    for (let i = 1; i < distinct.length; i++) {
        if (start - distinct[i] <= SWEEP_GAP_MS) {
            start = distinct[i]; // still within the latest sweep
        } else {
            break; // gap → boundary to an earlier capture pass
        }
    }
    return start;
}

/**
 * Recompute the cached market reference clocks from a listings array: the
 * in-game "now" (highest posted hours) and the most recent capture sweep (its
 * newest `lastObservedUtc` plus the start of that sweep's cluster). Called
 * whenever fresh listings load so the references stay current. Returns the
 * current in-game hours estimate.
 */
export function refreshMarketReferences(listings: AuctionListing[]): number {
    let maxHours = cachedCurrentGameHours;
    let maxObserved = cachedLatestObservedUtc;
    const observedMs: number[] = [];
    for (const l of listings) {
        const posted = l.postedTotalHours;
        if (posted != null && posted > maxHours) maxHours = posted;
        const observed = l.lastObservedUtc;
        if (observed != null) {
            if (observed > maxObserved) maxObserved = observed;
            const ms = Date.parse(observed);
            if (!Number.isNaN(ms)) observedMs.push(ms);
        }
    }
    cachedCurrentGameHours = maxHours;
    cachedLatestObservedUtc = maxObserved;
    cachedLatestSweepStartMs = computeLatestSweepStartMs(observedMs);
    return maxHours;
}

/** Best estimate of the current in-game total hours (0 when unknown). */
export function getCurrentGameHours(): number {
    return cachedCurrentGameHours;
}

/**
 * Timestamp of the most recent capture sweep of the live Auction House
 * (`""` when unknown). A listing observed at/after this was still on the board
 * in the latest sweep; an earlier one has since dropped off.
 */
export function getLatestObservedUtc(): string {
    return cachedLatestObservedUtc;
}

/** Start of the most recent capture sweep (epoch ms; 0 when unknown). Listings
 * observed at/after this were present in the latest sweep of the live board. */
export function getLatestSweepStartMs(): number {
    return cachedLatestSweepStartMs;
}

/**
 * Derived, display-level status of a listing — the single source of truth
 * shared by the status badge and the listings filter so they never disagree.
 *
 *  - "sold"        — a sale was recorded.
 *  - "expired"     — a terminal non-sale verdict (Expired) was recorded.
 *  - "active"      — last seen Active, present in the latest sweep and not due.
 *  - "removed"     — last seen Active but dropped out of the latest sweep or its
 *                    listing duration has elapsed, so it's no longer on the board.
 *  - "unconfirmed" — last seen Active with no sweep/clock reference to decide
 *                    (rendered as "Active?").
 *
 * `currentGameHours` defaults to the module-cached clock so callers that don't
 * thread it still get a best-effort result.
 */
export type ListingStatus = "sold" | "expired" | "active" | "removed" | "unconfirmed";

export function deriveListingStatus(
    listing: AuctionListing,
    currentGameHours?: number,
): ListingStatus {
    if (listing.sold) return "sold";
    // Fall back to the state when older data predates the verdictObserved field:
    // a terminal state (Expired) is inherently a recorded verdict.
    const verdictObserved = listing.verdictObserved ?? listing.state !== "Active";
    if (!verdictObserved) {
        // Last seen "Active", but that alone doesn't mean it's still listed. Two
        // signals prove it's gone: its duration has elapsed, or it fell out of
        // the most recent capture sweep of the live board (not observed since).
        const now = currentGameHours ?? getCurrentGameHours();
        const expired =
            listing.expireTotalHours != null && now > 0 && listing.expireTotalHours < now;
        const sweepStartMs = getLatestSweepStartMs();
        const lastMs = listing.lastObservedUtc ? Date.parse(listing.lastObservedUtc) : NaN;
        const observedInLatestSweep =
            sweepStartMs > 0 && !Number.isNaN(lastMs) ? lastMs >= sweepStartMs : null;
        if (observedInLatestSweep === true && !expired) return "active";
        if (observedInLatestSweep === false || expired) return "removed";
        return "unconfirmed";
    }
    return listing.state === "Expired" ? "expired" : "active";
}


/**
 * React hook returning the current in-game clock, derived from the full
 * listings dataset. Reads the shared `["auction","listings"]` query (no extra
 * fetch) so the reference clocks are refreshed even when the data was restored
 * from a persisted cache rather than a fresh network load. Computed over the
 * complete dataset — never a filtered subset — so the newest posting and the
 * latest sweep are never missed.
 */
export function useCurrentGameHours(): number {
    const { data } = useAuctionListings();
    return useMemo(
        () => (data ? refreshMarketReferences(data) : getCurrentGameHours()),
        [data],
    );
}

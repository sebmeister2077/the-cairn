#!/usr/bin/env node
/**
 * Multi-page Lighthouse audit for the SPA.
 *
 * Runs Lighthouse against every public route in one go (sequentially, in a
 * single headless Chrome), then prints a per-page score table and a
 * cross-page list of failing audits. Failures are grouped by audit and by
 * element, so a problem in the shared layout (header, nav, footer) shows up
 * once together with the pages it affects instead of once per page.
 *
 * It also reads the rendered <title>, meta description, canonical, robots
 * and <h1> of every page and checks them across pages (duplicate titles and
 * descriptions, canonicals that don't point at the page itself, ...), which
 * Lighthouse can't do because it only ever sees one page at a time, and
 * compares them with the HTML as served, before any JavaScript runs.
 *
 * Usage (from frontend/):
 *   npm run lighthouse                                    # production site
 *   npm run lighthouse -- --base http://localhost:4173    # local `npm run build && npm run preview`
 *   npm run lighthouse -- --routes /general,/market/items --desktop
 *   npm run lighthouse -- --categories seo,accessibility,best-practices,performance
 *   npm run lighthouse -- --color-scheme light            # contrast can differ per theme
 *   npm run lighthouse -- --min-score 90                  # exit 1 if any score is below 90
 *
 * In Windows PowerShell, npm's shim drops arguments after `--`; use
 * `npm.cmd run lighthouse -- ...` or `node scripts/lighthouse-audit.mjs ...`,
 * and quote comma-separated lists.
 *
 * Output goes to lighthouse-reports/<timestamp>/ (gitignored):
 *   summary.md, summary.json  scores, failing audits and metadata checks
 *   <route>.html              full Lighthouse report for each page
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import desktopConfig from "lighthouse/core/config/desktop-config.js";
import puppeteer from "puppeteer-core";

const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE_URL = "https://the-cairn.com";
const DEFAULT_CATEGORIES = ["seo", "accessibility", "best-practices"];
const CATEGORY_LABELS = {
  seo: "SEO",
  accessibility: "A11y",
  "best-practices": "BP",
  performance: "Perf",
};

// Public routes reachable from the header, nav tabs and footer. Keep in sync
// with <Routes> in src/components/AppContent.tsx. Admin-only (/manage,
// /audit, /usage), token (/download/:token) and per-player routes are left
// out on purpose. Blog posts are discovered from src/pages/blog/post-meta.ts.
const PUBLIC_ROUTES = [
  "/",
  "/general",
  "/multiplayer/tops-map",
  "/multiplayer/contribute-map",
  "/multiplayer/contribute-tls",
  "/singleplayer/extract",
  "/singleplayer/import",
  "/singleplayer/commands",
  "/singleplayer/delete",
  "/market",
  "/market/listings",
  "/market/items",
  "/market/price-index",
  "/market/insights",
  "/market/converter",
  "/market/orders",
  "/market/leaderboards",
  "/market/players",
  "/market/map",
  "/rarity/rocks",
  "/rarity/loot-pools",
  "/tools",
  "/tools/waypoints",
  "/tools/alloy-calculator",
  "/tools/charcoal-calculator",
  "/public/road-workers",
  "/blog",
  "/privacy",
  "/terms",
  "/account",
  "/preferences",
];

// Lighthouse resets storage before every page, so each run looks like a
// first-time visitor. Without these blocks every audited page would claim a
// brand-new production API key from the public invite, and page-view
// telemetry would count the audit as real traffic.
const BLOCKED_URL_PATTERNS = ["*/invite/default", "*/invite/*/claim", "*/usage/page-views"];

const MAX_ITEMS_PER_AUDIT = 10;
const MAX_SAMPLES_PER_ISSUE = 15;

const HELP = `Multi-page Lighthouse audit

Options:
  --base <url>          Site to audit (default: ${DEFAULT_BASE_URL}, or $LIGHTHOUSE_BASE_URL)
  --routes <list>       Comma-separated routes to audit instead of the built-in public list
  --categories <list>   Comma-separated categories (default: ${DEFAULT_CATEGORIES.join(",")})
                        Available: ${Object.keys(CATEGORY_LABELS).join(", ")}
  --desktop             Use desktop emulation instead of mobile (Lighthouse default)
  --color-scheme <s>    Emulate prefers-color-scheme: light or dark (default: the OS setting)
  --min-score <n>       Exit with code 1 when any page scores below n (0-100) in any category
                        (the SEO score of pages marked noindex is not checked)
  --out <dir>           Output directory (default: lighthouse-reports/<timestamp>)
  --skip-html           Don't write the per-page HTML reports
  -h, --help            Show this help

Extra Chrome flags can be passed in $LIGHTHOUSE_CHROME_FLAGS, e.g. "--no-sandbox" in CI, or
"--disable-web-security" to audit a local build whose data hosts only allow the production origin.
`;

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        base: { type: "string", default: process.env.LIGHTHOUSE_BASE_URL || DEFAULT_BASE_URL },
        routes: { type: "string" },
        categories: { type: "string", default: DEFAULT_CATEGORIES.join(",") },
        desktop: { type: "boolean", default: false },
        "color-scheme": { type: "string" },
        "min-score": { type: "string" },
        out: { type: "string" },
        "skip-html": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    return 2;
  }
  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const baseUrl = values.base.replace(/\/+$/, "");
  const categories = splitList(values.categories);
  const unknownCategories = categories.filter((c) => !(c in CATEGORY_LABELS));
  if (unknownCategories.length > 0) {
    console.error(`Unknown categories: ${unknownCategories.join(", ")}\n\n${HELP}`);
    return 2;
  }
  const minScore = values["min-score"] === undefined ? null : Number(values["min-score"]);
  if (minScore !== null && !(minScore >= 0 && minScore <= 100)) {
    console.error("--min-score must be a number between 0 and 100");
    return 2;
  }
  const colorScheme = values["color-scheme"] ?? null;
  if (colorScheme !== null && colorScheme !== "light" && colorScheme !== "dark") {
    console.error("--color-scheme must be light or dark");
    return 2;
  }
  const routes = values.routes
    ? splitList(values.routes).map((r) => (r.startsWith("/") ? r : `/${r}`))
    : await getDefaultRoutes();
  const outDir = path.resolve(
    FRONTEND_DIR,
    values.out ?? path.join("lighthouse-reports", timestampForPath()),
  );
  await mkdir(outDir, { recursive: true });

  const formFactor = values.desktop ? "desktop" : "mobile";
  console.log(
    `Auditing ${routes.length} page(s) on ${baseUrl} ` +
      `[${categories.map((c) => CATEGORY_LABELS[c]).join(", ")}, ${formFactor}, ` +
      `${colorScheme ?? "system"} color scheme]\n`,
  );

  const chrome = await chromeLauncher.launch({
    chromeFlags: [
      "--headless=new",
      ...(process.env.LIGHTHOUSE_CHROME_FLAGS ?? "").split(/\s+/).filter(Boolean),
    ],
  });
  const pages = [];
  let browser;
  try {
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${chrome.port}`,
      defaultViewport: null,
    });
    for (const [index, route] of routes.entries()) {
      const prefix = `[${String(index + 1).padStart(String(routes.length).length)}/${routes.length}]`;
      process.stdout.write(`${prefix} ${route} ... `);
      const startedAt = Date.now();
      const page = await auditPage(route, {
        baseUrl,
        browser,
        categories,
        desktop: values.desktop,
        colorScheme,
        writeHtml: !values["skip-html"],
        outDir,
      });
      pages.push(page);
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      console.log(
        page.error ? `FAILED: ${page.error}` : `${formatScoresInline(page.scores)} (${seconds}s)`,
      );
    }
  } finally {
    await browser?.disconnect().catch(() => {});
    try {
      await chrome.kill();
    } catch {
      // Windows sometimes refuses to delete the temp profile; harmless.
    }
  }

  const issues = aggregateIssues(pages);
  const metadataIssues = checkMetadata(pages);
  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    formFactor,
    colorScheme: colorScheme ?? "system",
    categories,
    lighthouseVersion: pages.find((p) => p.lighthouseVersion)?.lighthouseVersion ?? null,
    averages: averageScores(pages, categories),
    pages,
    issues,
    metadataIssues,
  };
  await writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(path.join(outDir, "summary.md"), renderMarkdown(summary));

  console.log(`\n${renderScoreTable(summary)}`);
  console.log(renderIssuesForTerminal(issues, pages.length));
  console.log(renderMetadataIssuesForTerminal(metadataIssues, pages.length));
  console.log(`Full summary: ${path.join(outDir, "summary.md")}`);

  if (minScore !== null) {
    const failures = pages.filter(
      (p) =>
        p.error ||
        categories.some(
          (c) => !(c === "seo" && p.noindex) && (p.scores[c] == null || p.scores[c] < minScore),
        ),
    );
    if (failures.length > 0) {
      console.error(
        `\n${failures.length} page(s) scored below ${minScore}: ${failures.map((p) => p.route).join(", ")}`,
      );
      return 1;
    }
  }
  return 0;
}

async function getDefaultRoutes() {
  const postsSource = await readFile(
    path.join(FRONTEND_DIR, "src/pages/blog/post-meta.ts"),
    "utf8",
  );
  const blogRoutes = [...postsSource.matchAll(/^\s*slug:\s*"([^"]+)"/gm)].map(
    (m) => `/blog/${m[1]}`,
  );
  if (blogRoutes.length === 0) {
    console.warn("No blog posts found in src/pages/blog/post-meta.ts; auditing without them.");
  }
  return [...new Set([...PUBLIC_ROUTES, ...blogRoutes])];
}

async function auditPage(
  route,
  { baseUrl, browser, categories, desktop, colorScheme, writeHtml, outDir },
) {
  const url = baseUrl + route;
  // Lighthouse leaves a page it was handed open on its final rendered state,
  // so the SEO metadata can be read afterwards without loading it again.
  let page;
  try {
    page = await browser.newPage();
    if (colorScheme) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: colorScheme }]);
    }
    const result = await lighthouse(
      url,
      {
        logLevel: "error",
        output: "html",
        onlyCategories: categories,
        blockedUrlPatterns: BLOCKED_URL_PATTERNS,
      },
      desktop ? desktopConfig : undefined,
      page,
    );
    if (!result) throw new Error("Lighthouse returned no result");
    const { lhr } = result;
    let reportFile = null;
    if (writeHtml) {
      reportFile = `${routeToFileName(route)}.html`;
      await writeFile(path.join(outDir, reportFile), result.report);
    }
    const finalPath = toPath(lhr.finalDisplayedUrl, baseUrl);
    const metadata = await readRenderedMetadata(page).catch(() => null);
    // A page marked noindex on purpose fails Lighthouse's is-crawlable audit
    // by design, so that failure isn't reported (and its SEO score isn't gated).
    const noindex = metadata?.robots.some((r) => /noindex/i.test(r)) ?? false;
    const failing = collectFailingAudits(lhr).filter((f) => !(noindex && f.id === "is-crawlable"));
    return {
      route,
      url,
      finalPath: finalPath !== route ? finalPath : null,
      lighthouseVersion: lhr.lighthouseVersion,
      runtimeError: lhr.runtimeError
        ? `${lhr.runtimeError.code}: ${lhr.runtimeError.message}`
        : null,
      scores: Object.fromEntries(
        categories.map((id) => [id, toPercent(lhr.categories[id]?.score)]),
      ),
      noindex,
      failing,
      metadata,
      staticHead: await readStaticHead(url).catch((err) => ({ error: err.message })),
      reportFile,
    };
  } catch (err) {
    return { route, url, error: err?.message ?? String(err), scores: {}, failing: [] };
  } finally {
    await page?.close().catch(() => {});
  }
}

function readRenderedMetadata(page) {
  return page.evaluate(() => {
    const attrs = (selector, name) =>
      Array.from(document.querySelectorAll(selector), (el) => el.getAttribute(name) ?? "");
    return {
      title: document.title.trim(),
      descriptions: attrs('meta[name="description"]', "content"),
      canonicals: attrs('link[rel="canonical"]', "href"),
      robots: attrs('meta[name="robots"]', "content"),
      h1: Array.from(document.querySelectorAll("h1"), (h) =>
        (h.textContent ?? "").replace(/\s+/g, " ").trim(),
      ),
    };
  });
}

/**
 * The <head> as served, before any JavaScript runs: what crawlers that don't
 * render pages and link previews (Discord, Slack, ...) get to see.
 */
async function readStaticHead(url) {
  const res = await fetch(url, { redirect: "follow" });
  const html = await res.text();
  const pick = (pattern) => decodeEntities(html.match(pattern)?.[1] ?? "") || null;
  return {
    status: res.status,
    title: pick(/<title>([^<]*)<\/title>/i),
    canonical: pick(/<link\s+rel="canonical"\s+href="([^"]*)"/i),
    robots: pick(/<meta\s+name="robots"\s+content="([^"]*)"/i),
  };
}

function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Cross-page checks on the rendered metadata. Pages marked noindex are
 * skipped, since search engines drop them anyway, and a route that redirects
 * to another audited page (e.g. / -> /general) is only counted once.
 */
function checkMetadata(pages) {
  const byIdentity = new Map();
  for (const p of pages) {
    if (!p.metadata || p.metadata.robots.some((r) => /noindex/i.test(r))) continue;
    const identity = stripQuery(p.finalPath ?? p.route);
    const existing = byIdentity.get(identity);
    if (!existing || (existing.route !== identity && p.route === identity)) {
      byIdentity.set(identity, p);
    }
  }
  const indexable = [...byIdentity.values()];
  const checks = [];
  const add = (id, title, routes, details = []) => {
    if (routes.length > 0) checks.push({ id, title, routes, details });
  };

  for (const [field, label] of [
    ["title", "<title>"],
    ["description", "meta description"],
  ]) {
    const byValue = new Map();
    for (const p of indexable) {
      const value = field === "title" ? p.metadata.title : p.metadata.descriptions[0];
      if (!value) continue;
      byValue.set(value, [...(byValue.get(value) ?? []), p.route]);
    }
    for (const [value, routes] of byValue) {
      if (routes.length > 1) {
        add(`duplicate-${field}`, `Same ${label} on ${routes.length} pages`, routes, [
          truncate(value, 160),
        ]);
      }
    }
  }

  add(
    "missing-title",
    "Empty <title>",
    indexable.filter((p) => !p.metadata.title).map((p) => p.route),
  );
  add(
    "missing-description",
    "No meta description",
    indexable.filter((p) => p.metadata.descriptions.length === 0).map((p) => p.route),
  );
  add(
    "multiple-descriptions",
    "More than one meta description",
    indexable.filter((p) => p.metadata.descriptions.length > 1).map((p) => p.route),
  );
  add(
    "missing-canonical",
    "No canonical link",
    indexable.filter((p) => p.metadata.canonicals.length === 0).map((p) => p.route),
  );
  add(
    "multiple-canonicals",
    "More than one canonical link (search engines ignore all of them)",
    indexable.filter((p) => p.metadata.canonicals.length > 1).map((p) => p.route),
  );
  const notSelfCanonical = indexable.filter((p) => {
    if (p.metadata.canonicals.length !== 1) return false;
    return canonicalPath(p.metadata.canonicals[0]) !== stripQuery(p.finalPath ?? p.route);
  });
  add(
    "canonical-not-self",
    "Canonical points to a different URL than the page itself",
    notSelfCanonical.map((p) => p.route),
    notSelfCanonical.map(
      (p) => `${stripQuery(p.finalPath ?? p.route)} -> ${canonicalPath(p.metadata.canonicals[0])}`,
    ),
  );
  add(
    "missing-h1",
    "No <h1> heading",
    indexable.filter((p) => p.metadata.h1.length === 0).map((p) => p.route),
  );
  const conflicting = indexable.filter(
    (p) =>
      p.staticHead?.canonical &&
      p.metadata.canonicals.length === 1 &&
      canonicalPath(p.staticHead.canonical) !== canonicalPath(p.metadata.canonicals[0]),
  );
  add(
    "static-canonical-conflict",
    "The served HTML and the rendered page point to different canonical URLs",
    conflicting.map((p) => p.route),
    conflicting.map(
      (p) =>
        `${p.route}: HTML ${canonicalPath(p.staticHead.canonical)}, rendered ${canonicalPath(p.metadata.canonicals[0])}`,
    ),
  );
  add(
    "no-static-head",
    "Served without a route-specific <head> (crawlers that don't run JavaScript and link previews see the site defaults)",
    indexable
      .filter((p) => p.staticHead && !p.staticHead.error && !p.staticHead.canonical)
      .map((p) => p.route),
  );
  return checks.sort((a, b) => b.routes.length - a.routes.length);
}

function canonicalPath(href) {
  try {
    return new URL(href).pathname.replace(/(.)\/+$/, "$1");
  } catch {
    return href;
  }
}

function stripQuery(routePath) {
  return routePath.split(/[?#]/)[0];
}

function collectFailingAudits(lhr) {
  const failing = [];
  for (const [category, { auditRefs }] of Object.entries(lhr.categories)) {
    for (const ref of auditRefs) {
      const audit = lhr.audits[ref.id];
      if (!audit || !isFailing(audit)) continue;
      failing.push({
        id: audit.id,
        category,
        title: audit.title,
        weight: ref.weight,
        score: audit.score,
        displayValue: audit.displayValue ?? null,
        explanation: audit.explanation ?? audit.errorMessage ?? null,
        items: summarizeItems(audit.details),
      });
    }
  }
  return failing;
}

function isFailing(audit) {
  if (audit.scoreDisplayMode === "error") return true;
  if (!["binary", "numeric", "metricSavings"].includes(audit.scoreDisplayMode)) return false;
  return audit.score !== null && audit.score < 0.9;
}

function summarizeItems(details) {
  if (!details?.items) return [];
  const items =
    details.type === "list" ? details.items.flatMap((sub) => sub.items ?? []) : details.items;
  return items.slice(0, MAX_ITEMS_PER_AUDIT).map(summarizeItem).filter(Boolean);
}

function summarizeItem(item) {
  // Accessibility (axe) and most SEO audits point at DOM nodes.
  if (item.node?.type === "node") {
    return dropEmpty({
      selector: item.node.selector,
      label: truncate(item.node.nodeLabel, 100),
      snippet: truncate(item.node.snippet, 240),
      explanation: truncate(item.node.explanation, 400),
    });
  }
  // Everything else (robots.txt lines, link hrefs, console errors, ...).
  const flat = {};
  for (const [key, value] of Object.entries(item)) {
    if (value == null || key === "subItems") continue;
    if (typeof value === "string") flat[key] = truncate(value, 240);
    else if (typeof value === "number" || typeof value === "boolean") flat[key] = value;
    else if (value.type === "node") flat[key] = value.selector ?? truncate(value.snippet, 240);
    else if (value.type === "source-location") flat[key] = `${value.url}:${value.line}`;
    else if (value.type === "url" || value.type === "code") flat[key] = truncate(value.value, 240);
  }
  return Object.keys(flat).length > 0 ? flat : null;
}

function aggregateIssues(pages) {
  const byKey = new Map();
  for (const page of pages) {
    for (const audit of page.failing) {
      const key = `${audit.category}/${audit.id}`;
      let issue = byKey.get(key);
      if (!issue) {
        issue = {
          category: audit.category,
          id: audit.id,
          title: audit.title,
          weight: audit.weight,
          routes: [],
          explanations: new Set(),
          samples: new Map(),
        };
        byKey.set(key, issue);
      }
      issue.routes.push(page.route);
      if (audit.explanation) issue.explanations.add(audit.explanation);
      for (const item of audit.items) {
        const sampleKey = item.selector ?? JSON.stringify(item);
        const sample = issue.samples.get(sampleKey) ?? { ...item, routes: [], count: 0 };
        sample.count += 1;
        if (!sample.routes.includes(page.route)) sample.routes.push(page.route);
        issue.samples.set(sampleKey, sample);
      }
    }
  }
  return [...byKey.values()]
    .map((issue) => ({
      ...issue,
      explanations: [...issue.explanations],
      samples: [...issue.samples.values()]
        .sort((a, b) => b.routes.length - a.routes.length)
        .slice(0, MAX_SAMPLES_PER_ISSUE),
    }))
    .sort(
      (a, b) =>
        b.routes.length - a.routes.length || b.weight - a.weight || a.id.localeCompare(b.id),
    );
}

function averageScores(pages, categories) {
  return Object.fromEntries(
    categories.map((c) => {
      const scores = pages.map((p) => p.scores[c]).filter((s) => typeof s === "number");
      return [
        c,
        scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      ];
    }),
  );
}

function renderScoreTable({ pages, categories, averages }) {
  const routeWidth = Math.max(7, ...pages.map((p) => p.route.length));
  const header =
    "Route".padEnd(routeWidth) + categories.map((c) => CATEGORY_LABELS[c].padStart(6)).join("");
  const rows = pages.map((p) => {
    const notes = p.error
      ? [`FAILED: ${p.error}`]
      : [p.finalPath && `-> ${p.finalPath}`, p.noindex && "noindex"].filter(Boolean);
    return (
      p.route.padEnd(routeWidth) +
      categories.map((c) => colorScore(p.scores[c], 6)).join("") +
      (notes.length ? `  ${notes.join("  ")}` : "")
    );
  });
  const average =
    "Average".padEnd(routeWidth) + categories.map((c) => colorScore(averages[c], 6)).join("");
  const rule = "-".repeat(header.length);
  return [header, rule, ...rows, rule, average].join("\n");
}

function renderIssuesForTerminal(issues, pageCount) {
  if (issues.length === 0) return "\nNo failing audits.\n";
  const lines = [`\nFailing audits (most widespread first, ${pageCount} page(s) audited):\n`];
  issues.forEach((issue, i) => {
    lines.push(
      `${String(i + 1).padStart(2)}. [${CATEGORY_LABELS[issue.category]}] ${issue.id}: ` +
        `${stripMarkdown(issue.title)} (${issue.routes.length}/${pageCount} pages, weight ${issue.weight})`,
    );
    for (const explanation of issue.explanations.slice(0, 2)) {
      lines.push(`      ${truncate(oneLine(explanation), 160)}`);
    }
    for (const sample of issue.samples.slice(0, 3)) {
      const what = sample.selector ?? truncate(JSON.stringify(dropRoutes(sample)), 140);
      lines.push(`      - ${truncate(what, 140)} (${occurrences(sample)})`);
    }
  });
  return `${lines.join("\n")}\n`;
}

function renderMetadataIssuesForTerminal(metadataIssues, pageCount) {
  if (metadataIssues.length === 0) return "Rendered metadata: no cross-page problems found.\n";
  const lines = [`Rendered metadata checks (not covered by Lighthouse, ${pageCount} page(s)):\n`];
  for (const check of metadataIssues) {
    lines.push(` - ${check.id}: ${check.title} (${check.routes.length} page(s))`);
    for (const detail of check.details.slice(0, 3)) lines.push(`      ${detail}`);
    if (check.details.length > 3) lines.push(`      ... and ${check.details.length - 3} more`);
  }
  return `${lines.join("\n")}\n`;
}

function renderMarkdown({
  generatedAt,
  baseUrl,
  formFactor,
  colorScheme,
  lighthouseVersion,
  categories,
  averages,
  pages,
  issues,
  metadataIssues,
}) {
  const md = [];
  md.push(`# Lighthouse audit: ${baseUrl}`);
  md.push("");
  md.push(
    `Generated ${generatedAt} with Lighthouse ${lighthouseVersion ?? "?"} ` +
      `(${formFactor}, ${colorScheme} color scheme), ${pages.length} page(s).`,
  );
  md.push("");
  md.push(`| Route | ${categories.map((c) => CATEGORY_LABELS[c]).join(" | ")} | Notes |`);
  md.push(`| --- | ${categories.map(() => "---:").join(" | ")} | --- |`);
  for (const p of pages) {
    const route = p.reportFile ? `[${p.route}](./${p.reportFile})` : p.route;
    const note = p.error
      ? `FAILED: ${p.error}`
      : [
          p.finalPath && `redirects to ${p.finalPath}`,
          p.noindex && "noindex on purpose (Lighthouse's is-crawlable audit fails by design)",
          p.runtimeError,
        ]
          .filter(Boolean)
          .join("; ");
    md.push(`| ${route} | ${categories.map((c) => p.scores[c] ?? "-").join(" | ")} | ${note} |`);
  }
  md.push(`| **Average** | ${categories.map((c) => `**${averages[c] ?? "-"}**`).join(" | ")} | |`);
  md.push("");
  md.push("## Failing audits");
  md.push("");
  if (issues.length === 0) md.push("None.");
  issues.forEach((issue, i) => {
    md.push(`### ${i + 1}. [${CATEGORY_LABELS[issue.category]}] \`${issue.id}\`: ${issue.title}`);
    md.push("");
    md.push(
      `Failing on ${issue.routes.length}/${pages.length} pages (weight ${issue.weight}): ${issue.routes.map((r) => `\`${r}\``).join(", ")}`,
    );
    md.push("");
    for (const explanation of issue.explanations.slice(0, 3)) {
      md.push(`> ${oneLine(explanation)}`);
      md.push("");
    }
    for (const sample of issue.samples.slice(0, 8)) {
      const pagesNote = occurrences(sample);
      if (sample.selector) {
        md.push(`- \`${sample.selector}\` (${pagesNote})`);
        if (sample.snippet) md.push(`  - Snippet: \`${sample.snippet.replace(/`/g, "'")}\``);
        if (sample.explanation) md.push(`  - ${oneLine(sample.explanation)}`);
      } else {
        md.push(`- \`${JSON.stringify(dropRoutes(sample)).replace(/`/g, "'")}\` (${pagesNote})`);
      }
    }
    md.push("");
  });

  md.push("## Rendered metadata checks");
  md.push("");
  md.push("Cross-page checks Lighthouse doesn't do (noindex pages are skipped).");
  md.push("");
  if (metadataIssues.length === 0) md.push("No problems found.");
  for (const check of metadataIssues) {
    md.push(`- **${check.id}**: ${check.title} (${check.routes.length} page(s))`);
    for (const detail of check.details) md.push(`  - \`${detail.replace(/`/g, "'")}\``);
    if (check.details.length === 0) {
      md.push(`  - ${check.routes.map((r) => `\`${r}\``).join(", ")}`);
    }
  }
  md.push("");
  md.push("## Rendered metadata per page");
  md.push("");
  md.push("The last column is the canonical URL in the HTML as served, before JavaScript runs.");
  md.push("");
  md.push("| Route | Title | Description | Canonical | Robots | H1 | Served canonical |");
  md.push("| --- | --- | --- | --- | --- | --- | --- |");
  const cell = (value) => (value ? String(value).replace(/\|/g, "\\|") : "-");
  for (const p of pages) {
    const m = p.metadata;
    if (!m) {
      md.push(`| ${p.route} | - | - | - | - | - | - |`);
      continue;
    }
    const served = p.staticHead?.error
      ? `error: ${p.staticHead.error}`
      : p.staticHead?.canonical && canonicalPath(p.staticHead.canonical);
    md.push(
      `| ${p.route} | ${cell(truncate(m.title, 70))} | ${cell(truncate(m.descriptions.join(" / "), 70))} | ` +
        `${cell(m.canonicals.map(canonicalPath).join(", "))} | ${cell(m.robots.join(", "))} | ` +
        `${cell(truncate(m.h1.join(" / "), 50))} | ${cell(served)} |`,
    );
  }
  md.push("");
  return md.join("\n");
}

function occurrences(sample) {
  const pagesText = `${sample.routes.length} page(s)`;
  return sample.count > sample.routes.length ? `${sample.count}x on ${pagesText}` : pagesText;
}

function colorScore(score, width) {
  const text = (score ?? "-").toString().padStart(width);
  if (!process.stdout.isTTY || typeof score !== "number") return text;
  const color = score >= 90 ? 32 : score >= 50 ? 33 : 31;
  return `\x1b[${color}m${text}\x1b[0m`;
}

function formatScoresInline(scores) {
  return Object.entries(scores)
    .map(([c, s]) => `${CATEGORY_LABELS[c]} ${s ?? "-"}`)
    .join("  ");
}

function toPercent(score) {
  return typeof score === "number" ? Math.round(score * 100) : null;
}

function toPath(url, baseUrl) {
  if (!url) return null;
  return url.startsWith(baseUrl) ? url.slice(baseUrl.length) || "/" : url;
}

function routeToFileName(route) {
  return route === "/" ? "home" : route.replace(/^\/+/, "").replace(/[^a-z0-9-]+/gi, "_");
}

function timestampForPath() {
  return new Date().toISOString().slice(0, 19).replace(/:/g, "-");
}

function splitList(value) {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function truncate(value, max) {
  if (typeof value !== "string") return value;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function oneLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function stripMarkdown(value) {
  return value.replace(/`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function dropEmpty(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== ""));
}

function dropRoutes(sample) {
  const { routes: _routes, count: _count, ...rest } = sample;
  return rest;
}

process.exitCode = await main();

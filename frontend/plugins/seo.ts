import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { BLOG_POSTS } from "../src/pages/blog/post-meta.ts";
import {
  DEFAULT_SEO,
  PAGE_SEO,
  SITE_URL,
  getHeadTags,
  type HeadTag,
  type PageSeo,
} from "../src/lib/seo/pages.ts";

const START_MARKER = "<!-- seo:start -->";
const END_MARKER = "<!-- seo:end -->";

/**
 * Build-time SEO output, driven by src/lib/seo/pages.ts:
 * - index.html gets the default title and description, and no canonical URL,
 *   since the host serves it for every route without a file of its own;
 * - every static route and blog post gets a copy at `<route>/index.html`
 *   with its own title, description, canonical and robots tags. The host
 *   serves these files ahead of the SPA rewrite, so crawlers and link
 *   previews that don't run JavaScript still see the right metadata;
 * - sitemap.xml lists every indexable page.
 *
 * It also makes `vite preview` serve `<route>/index.html` for `/route` the
 * way the production host does, so local Lighthouse runs see the same HTML.
 */
export function seoPlugin(): Plugin[] {
  return [seoBuildPlugin(), previewRouteFilesPlugin()];
}

function seoBuildPlugin(): Plugin {
  return {
    name: "cairn-seo",
    apply: "build",
    enforce: "post",
    transformIndexHtml(html) {
      return withHeadTags(html, getHeadTags(DEFAULT_SEO, null));
    },
    generateBundle(_options, bundle) {
      const index = bundle["index.html"];
      if (index?.type !== "asset" || typeof index.source !== "string") {
        this.error("index.html is missing from the bundle");
      }
      for (const [path, seo] of getStaticPages()) {
        this.emitFile({
          type: "asset",
          fileName: `${path.slice(1)}/index.html`,
          source: withHeadTags(index.source, getHeadTags(seo, path)),
        });
      }
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: renderSitemap() });
    },
  };
}

function previewRouteFilesPlugin(): Plugin {
  return {
    name: "cairn-seo-preview",
    apply: (_config, env) => Boolean(env.isPreview),
    configurePreviewServer(server) {
      const outDir = path.resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "/";
        const queryStart = url.indexOf("?");
        const pathname = queryStart === -1 ? url : url.slice(0, queryStart);
        const hasRouteFile =
          pathname !== "/" &&
          !pathname.endsWith("/") &&
          !path.extname(pathname) &&
          fs.existsSync(path.join(outDir, decodeURIComponent(pathname), "index.html"));
        if (hasRouteFile) {
          req.url = `${pathname}/${queryStart === -1 ? "" : url.slice(queryStart)}`;
        }
        next();
      });
    },
  };
}

function getStaticPages(): Array<[string, PageSeo]> {
  const blogPages = BLOG_POSTS.map((post): [string, PageSeo] => [
    `/blog/${post.slug}`,
    { title: post.translations.en.title, description: post.translations.en.excerpt },
  ]);
  return [...Object.entries(PAGE_SEO), ...blogPages];
}

function withHeadTags(html: string, tags: HeadTag[]): string {
  const start = html.indexOf(START_MARKER);
  const end = html.indexOf(END_MARKER);
  if (start === -1 || end < start) {
    throw new Error(`index.html must contain ${START_MARKER} and ${END_MARKER}`);
  }
  const indent = "    ";
  const rendered = tags.map((tag) => indent + renderTag(tag)).join("\n");
  return `${html.slice(0, start + START_MARKER.length)}\n${rendered}\n${indent}${html.slice(end)}`;
}

function renderTag(tag: HeadTag): string {
  switch (tag.tag) {
    case "title":
      return `<title>${escapeHtml(tag.text)}</title>`;
    case "meta":
      return `<meta ${tag.attr}="${escapeHtml(tag.key)}" content="${escapeHtml(tag.content)}" />`;
    case "link":
      return `<link rel="${escapeHtml(tag.rel)}" href="${escapeHtml(tag.href)}" />`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderSitemap(): string {
  const lastModified = new Map(BLOG_POSTS.map((post) => [`/blog/${post.slug}`, post.date]));
  const urls = getStaticPages()
    .filter(([, seo]) => !seo.noindex && !seo.canonicalPath)
    .map(([path]) => {
      const lastmod = lastModified.get(path);
      const lastmodTag = lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : "";
      return `  <url>\n    <loc>${SITE_URL}${path}</loc>${lastmodTag}\n  </url>`;
    });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

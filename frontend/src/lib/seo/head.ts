import type { HeadTag } from "./pages";

// <head> tags owned by the SEO helpers. Any of these not in the current
// page's tag list is removed, e.g. the canonical link of a noindex page.
const MANAGED_META: ReadonlyArray<readonly ["name" | "property", string]> = [
  ["name", "description"],
  ["name", "robots"],
  ["name", "twitter:title"],
  ["name", "twitter:description"],
  ["property", "og:title"],
  ["property", "og:description"],
  ["property", "og:url"],
];

export function applyHeadTags(tags: HeadTag[]): void {
  const applied = new Set<string>();
  for (const tag of tags) {
    if (tag.tag === "title") {
      document.title = tag.text;
    } else if (tag.tag === "meta") {
      applied.add(`${tag.attr}:${tag.key}`);
      let el = document.head.querySelector<HTMLMetaElement>(`meta[${tag.attr}="${tag.key}"]`);
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute(tag.attr, tag.key);
        document.head.appendChild(el);
      }
      el.content = tag.content;
    } else {
      applied.add(`link:${tag.rel}`);
      let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${tag.rel}"]`);
      if (!el) {
        el = document.createElement("link");
        el.rel = tag.rel;
        document.head.appendChild(el);
      }
      el.href = tag.href;
    }
  }
  for (const [attr, key] of MANAGED_META) {
    if (!applied.has(`${attr}:${key}`)) {
      document.head.querySelector(`meta[${attr}="${key}"]`)?.remove();
    }
  }
  if (!applied.has("link:canonical")) {
    document.head.querySelector('link[rel="canonical"]')?.remove();
  }
}

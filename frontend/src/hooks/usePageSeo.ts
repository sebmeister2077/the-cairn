import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { applyHeadTags } from "@/lib/seo/head";
import { getHeadTags, normalizePath, type PageSeo } from "@/lib/seo/pages";

/**
 * Applies a page's title, description, canonical URL and robots directive to
 * <head>. Static routes get theirs from <RouteSeo />; dynamic pages (blog
 * posts, market items, ...) and the 404 page call this themselves. Passing
 * null leaves <head> untouched.
 */
export function usePageSeo(seo: PageSeo | null): void {
  const path = normalizePath(useLocation().pathname);
  const title = seo?.title;
  const description = seo?.description;
  const noindex = seo?.noindex ?? false;
  const canonicalPath = seo?.canonicalPath;

  useEffect(() => {
    if (title === undefined || description === undefined) return;
    applyHeadTags(getHeadTags({ title, description, noindex, canonicalPath }, path));
  }, [title, description, noindex, canonicalPath, path]);
}

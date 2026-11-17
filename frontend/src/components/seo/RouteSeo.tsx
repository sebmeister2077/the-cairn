import { useLocation } from "react-router-dom";
import { usePageSeo } from "@/hooks/usePageSeo";
import { DEFAULT_SEO, getRouteSeo } from "@/lib/seo/pages";

/**
 * Applies the SEO metadata of the current route (see lib/seo/pages.ts), or
 * the site defaults for routes without an entry. Render it before the routes:
 * pages that call usePageSeo themselves (blog posts, market items, the 404
 * page, ...) then override it, because their effects run after this one.
 */
export function RouteSeo(): null {
  usePageSeo(getRouteSeo(useLocation().pathname) ?? DEFAULT_SEO);
  return null;
}

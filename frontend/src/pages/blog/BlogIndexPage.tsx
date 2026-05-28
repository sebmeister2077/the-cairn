import { NavLink } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useFormat, useTranslation } from "@/lib/i18n";
import { getBlogPosts } from "./posts";

export function BlogIndexPage() {
  const { locale, t } = useTranslation();
  const { dateTime } = useFormat();
  const posts = getBlogPosts(locale);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("blog.index.title")}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>{t("blog.index.description")}</p>
        </CardContent>
      </Card>

      <ul className="space-y-3">
        {posts.map((post) => (
          <li key={post.slug}>
            <NavLink
              to={`/blog/${post.slug}`}
              className="block rounded-lg border bg-card text-card-foreground transition hover:border-primary/40 hover:shadow-sm"
            >
              <div className="p-4 space-y-2">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <h2 className="text-base font-semibold leading-snug">{post.title}</h2>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatDate(post.date, dateTime)} ·{" "}
                    {t("blog.meta.readTime", { count: post.readingMinutes })}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{post.excerpt}</p>
                {post.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {post.tags.map((t) => (
                      <Badge key={t} variant="secondary" className="text-[10px]">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatDate(
  iso: string,
  dateTime: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string,
): string {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return dateTime(d, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

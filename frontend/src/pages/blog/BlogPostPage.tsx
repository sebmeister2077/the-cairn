import { NavLink, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFormat, useTranslation } from "@/lib/i18n";
import { ArrowLeft } from "lucide-react";
import { getPostBySlug } from "./posts";

export function BlogPostPage() {
  const { locale, t } = useTranslation();
  const { dateTime } = useFormat();
  const { slug } = useParams<{ slug: string }>();
  const post = slug ? getPostBySlug(locale, slug) : undefined;

  if (!post) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("blog.postPage.notFoundTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>{t("blog.postPage.notFoundDescription")}</p>
          <NavLink to="/blog">
            <Button variant="outline" size="sm">
              <ArrowLeft className="size-4 mr-1.5" />
              {t("blog.postPage.backToBlog")}
            </Button>
          </NavLink>
        </CardContent>
      </Card>
    );
  }

  const { Component } = post;

  return (
    <article className="space-y-4">
      <NavLink to="/blog">
        <Button variant="ghost" size="sm" className="-ml-2">
          <ArrowLeft className="size-4 mr-1.5" />
          {t("blog.postPage.allPosts")}
        </Button>
      </NavLink>

      <header className="space-y-3">
        <h1 className="text-2xl font-semibold leading-tight">{post.title}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{formatDate(post.date, dateTime)}</span>
          <span aria-hidden>·</span>
          <span>{t("blog.meta.readTime", { count: post.readingMinutes })}</span>
          {post.tags.length > 0 && (
            <>
              <span aria-hidden>·</span>
              <div className="flex flex-wrap gap-1.5">
                {post.tags.map((t) => (
                  <Badge key={t} variant="secondary" className="text-[10px]">
                    {t}
                  </Badge>
                ))}
              </div>
            </>
          )}
        </div>
      </header>

      <div className="prose-sm max-w-none">
        <Component />
      </div>
    </article>
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
    month: "long",
    day: "numeric",
  });
}

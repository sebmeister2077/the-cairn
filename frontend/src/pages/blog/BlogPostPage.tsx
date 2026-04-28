import { NavLink, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { getPostBySlug } from "./posts";

export function BlogPostPage() {
  const { slug } = useParams<{ slug: string }>();
  const post = slug ? getPostBySlug(slug) : undefined;

  if (!post) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Post not found</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>We couldn&rsquo;t find a post with that link. It may have been renamed or removed.</p>
          <NavLink to="/blog">
            <Button variant="outline" size="sm">
              <ArrowLeft className="size-4 mr-1.5" />
              Back to blog
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
          All posts
        </Button>
      </NavLink>

      <header className="space-y-3">
        <h1 className="text-2xl font-semibold leading-tight">{post.title}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{formatDate(post.date)}</span>
          <span aria-hidden>·</span>
          <span>{post.readingMinutes} min read</span>
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

function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

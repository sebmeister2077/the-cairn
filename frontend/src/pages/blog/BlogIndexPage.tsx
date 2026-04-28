import { NavLink } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BLOG_POSTS } from "./posts";

export function BlogIndexPage() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Blog</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>
            Guides, walkthroughs, and notes about Cairn and the shared <em>Vintage Story</em> map.
          </p>
        </CardContent>
      </Card>

      <ul className="space-y-3">
        {BLOG_POSTS.map((post) => (
          <li key={post.slug}>
            <NavLink
              to={`/blog/${post.slug}`}
              className="block rounded-lg border bg-card text-card-foreground transition hover:border-primary/40 hover:shadow-sm"
            >
              <div className="p-4 space-y-2">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <h2 className="text-base font-semibold leading-snug">{post.title}</h2>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatDate(post.date)} · {post.readingMinutes} min read
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

function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

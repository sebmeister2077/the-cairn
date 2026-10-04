import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";

/**
 * Auto-loads the next page of an infinite query when it scrolls into view.
 * Renders a small sentinel that triggers ``fetchNextPage`` via an
 * IntersectionObserver, so the user never has to click "load more".
 */
export function InfiniteScrollSentinel({
  query,
}: {
  query: {
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    fetchNextPage: () => void;
  };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  useEffect(() => {
    const el = ref.current;
    if (!el || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (!hasNextPage) return null;

  return (
    <div ref={ref} className="flex justify-center py-3">
      {isFetchingNextPage && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
    </div>
  );
}

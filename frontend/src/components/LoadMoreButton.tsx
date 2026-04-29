import { Loader2 } from "lucide-react";
import { Button } from "./ui/button";

export function LoadMoreButton({
  query,
}: {
  query: {
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    fetchNextPage: () => void;
  };
}) {
  if (!query.hasNextPage) return null;
  return (
    <div className="pt-2 flex justify-center">
      <Button
        size="sm"
        variant="outline"
        disabled={query.isFetchingNextPage}
        onClick={() => query.fetchNextPage()}
      >
        {query.isFetchingNextPage ? (
          <>
            <Loader2 className="size-3 animate-spin" />
            Loading…
          </>
        ) : (
          "Load more"
        )}
      </Button>
    </div>
  );
}

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./ui/button";

export function Pagination({
  page,
  pageCount,
  onPageChange,
  isFetching,
}: {
  page: number;
  pageCount: number;
  onPageChange: (p: number) => void;
  isFetching: boolean;
}) {
  if (pageCount <= 1) return null;
  const canPrev = page > 0;
  const canNext = page < pageCount - 1;
  return (
    <div className="pt-2 flex items-center justify-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={!canPrev || isFetching}
        onClick={() => onPageChange(Math.max(0, page - 1))}
      >
        <ChevronLeft className="size-3" />
        Previous
      </Button>
      <span className="text-xs text-muted-foreground tabular-nums px-2">
        Page {page + 1} of {pageCount}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={!canNext || isFetching}
        onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))}
      >
        Next
        <ChevronRight className="size-3" />
      </Button>
    </div>
  );
}

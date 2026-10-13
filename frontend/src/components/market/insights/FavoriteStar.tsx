import { cn } from "@/lib/utils";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { Star } from "lucide-react";
import { toggleFavorite } from "@/store/slices/marketFavorites";

/** Star toggle for the Item column. Subscribes to just this item's favorite
 *  state so toggling one row doesn't re-render the whole screener. */
export function MarketInsightsFavoriteStar({ itemId }: { itemId: number }) {
  const dispatch = useAppDispatch();
  const isFavorite = useAppSelector((s) => s.marketFavorites.ids.includes(itemId));
  return (
    <button
      type="button"
      aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={isFavorite}
      onClick={(e) => {
        e.stopPropagation();
        dispatch(toggleFavorite(itemId));
      }}
      className="-ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded hover:bg-muted"
    >
      <Star
        className={cn(
          "size-3.5 transition-colors",
          isFavorite
            ? "fill-amber-400 text-amber-400"
            : "text-muted-foreground/40 hover:text-muted-foreground",
        )}
      />
    </button>
  );
}

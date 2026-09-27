import { ArrowUp, Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Amber caveat chip shown when the market never revealed a price ceiling for
 * an item: no expired listing was ever priced above the highest one that sold.
 * — so we flag that the true upper bound is unknown. */
export function UpperBoundUnknownBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/15 px-2.5 py-1 text-sm font-medium text-amber-600">
      <ArrowUp className="size-4" aria-hidden />
      Upper price bound unknown
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label="Why is the upper price bound unknown?"
              className="inline-flex cursor-pointer items-center rounded-full p-0.5 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Info className="size-4" />
            </button>
          }
        />
        <PopoverContent className="max-w-xs">
          <div className="space-y-1.5 text-left">
            <p>
              No expired listing for this item was ever priced above the highest one that actually
              sold.
            </p>
            <p>
              That means the market never showed a price too high to sell at, so the true ceiling is
              unknown — the fair price here is likely a{" "}
              <span className="text-foreground">floor</span>, and buyers may have been willing to
              pay more.
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}

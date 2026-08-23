import { Info } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { patchAuctionFilters } from "@/store/slices/auctionFilters";

/**
 * Shared "Hide off-platform trades" checkbox + info popover, used on the
 * Listings, Insights, Item and Converter pages. Backed by the single
 * `auctionFilters.excludeExternalTrades` setting so all pages stay in sync.
 * `className` tunes the wrapper (e.g. `h-9` to align with a filter bar).
 */
export function ExternalTradeToggle({ className }: { className?: string }) {
  const dispatch = useAppDispatch();
  const checked = useAppSelector((s) => s.auctionFilters.excludeExternalTrades);
  return (
    <div className={cn("flex items-center gap-1.5 text-sm", className)}>
      <label className="flex cursor-pointer items-center gap-2">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) =>
            dispatch(patchAuctionFilters({ excludeExternalTrades: v === true }))
          }
        />
        Hide off-platform trades
      </label>
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label="What are off-platform trades?"
              className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <Info className="h-3.5 w-3.5" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 text-sm">
          <p className="font-medium">Off-platform trades</p>
          <p className="mt-1 text-muted-foreground">
            Players sometimes use the Auction House just to hand over an item they already agreed to
            swap for something else, listing it at a token price. That price isn't a real market
            value, so these sales are left out of the price stats.
          </p>
          <p className="mt-3 font-medium">A sale is flagged when it:</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
            <li>
              sold for exactly <strong className="text-foreground">1 rusty gear</strong>,
            </li>
            <li>
              sold <strong className="text-foreground">within ~30 minutes</strong> of listing (a
              pre-arranged hand-off), and
            </li>
            <li>actually sold — not expired or cancelled.</li>
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}

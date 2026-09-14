import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { SMART_WINDOW_HINT } from "@/hooks/useMarketInsights";

/**
 * Caption shown under a market page's time-range control when the adaptive
 * "Smart" window is active, explaining why prices may span a different age per
 * item. Renders nothing for the fixed windows. `basis-full` lets it drop onto
 * its own line inside the flex-wrap control rows the market pages use.
 */
export function SmartWindowNote({
  windowKey,
  className,
}: {
  windowKey: string;
  className?: string;
}) {
  if (windowKey !== "smart") return null;
  return (
    <p
      className={cn(
        "basis-full flex items-start gap-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
      <span>
        <span className="font-medium text-foreground">Smart range:</span> {SMART_WINDOW_HINT}
      </span>
    </p>
  );
}

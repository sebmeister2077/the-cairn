import { useCallback } from "react";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Slider } from "../ui/slider";
import { cn } from "@/lib/utils";

export type AuctionLayer = "off" | "sell" | "buy" | "both";

interface AuctionHeatmapControlProps {
  layer: AuctionLayer;
  onLayerChange: (next: AuctionLayer) => void;
  /** Overlay opacity in the 0-1 range. */
  opacity: number;
  onOpacityChange: (next: number) => void;
  /**
   * `"card"` renders the opaque bordered card used in the normal controls
   * column; `"fullscreen"` renders the translucent floating panel used by the
   * fullscreen overlay stack.
   */
  variant?: "card" | "fullscreen";
}

/**
 * Toggle + sell/buy chips for the Auction House "trade density" heatmap
 * overlay. Shared between {@link TOPSMapViewPage}'s controls column and the
 * fullscreen {@link FullscreenControlsOverlay} so the layer is reachable in
 * both modes. The parent owns the `layer` state (it also drives the overlay
 * rendering); this component only derives the sell/buy booleans and the
 * per-chip toggle transitions.
 */
export function AuctionHeatmapControl({
  layer,
  onLayerChange,
  opacity,
  onOpacityChange,
  variant = "card",
}: AuctionHeatmapControlProps) {
  const active = layer !== "off";
  const showSell = layer === "sell" || layer === "both";
  const showBuy = layer === "buy" || layer === "both";
  const fullscreen = variant === "fullscreen";

  const toggleSell = useCallback(() => {
    const sellOn = layer === "sell" || layer === "both";
    const buyOn = layer === "buy" || layer === "both";
    onLayerChange(!sellOn ? (buyOn ? "both" : "sell") : buyOn ? "buy" : "off");
  }, [layer, onLayerChange]);

  const toggleBuy = useCallback(() => {
    const sellOn = layer === "sell" || layer === "both";
    const buyOn = layer === "buy" || layer === "both";
    onLayerChange(!buyOn ? (sellOn ? "both" : "buy") : sellOn ? "sell" : "off");
  }, [layer, onLayerChange]);

  return (
    <div
      className={cn(
        "flex flex-col rounded-md border px-3 py-2 text-sm",
        fullscreen && "bg-background/95 shadow-md backdrop-blur",
      )}
    >
      <div className="flex items-center gap-2">
        <Switch
          checked={active}
          onCheckedChange={(on) => onLayerChange(on ? "both" : "off")}
          aria-label="Toggle trade heatmap overlay"
        />
        <Label>Trade heatmap</Label>
        <span className={cn("text-xs text-muted-foreground", fullscreen ? "ml-auto" : "ml-2")}>
          Auction House trade density
        </span>
      </div>
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: active ? "1fr" : "0fr" }}
        aria-hidden={!active}
      >
        <div className="overflow-hidden min-h-0">
          <div className="flex flex-wrap gap-2 pt-3">
            <button
              type="button"
              onClick={toggleSell}
              tabIndex={active ? 0 : -1}
              aria-pressed={showSell}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs cursor-pointer transition-colors duration-150",
                showSell
                  ? "border-blue-500 bg-blue-500/15 text-foreground"
                  : "border-input opacity-70 hover:opacity-100",
              )}
            >
              <span className="size-2.5 rounded-full bg-blue-500" /> Sell origins
            </button>
            <button
              type="button"
              onClick={toggleBuy}
              tabIndex={active ? 0 : -1}
              aria-pressed={showBuy}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs cursor-pointer transition-colors duration-150",
                showBuy
                  ? "border-red-500 bg-red-500/15 text-foreground"
                  : "border-input opacity-70 hover:opacity-100",
              )}
            >
              <span className="size-2.5 rounded-full bg-red-500" /> Buy destinations
            </button>
          </div>
          <div className="flex items-center gap-2 pt-3">
            <Label className="text-xs text-muted-foreground whitespace-nowrap">Intensity</Label>
            <Slider
              value={Math.round(opacity * 100)}
              min={10}
              max={100}
              step={5}
              onValueChange={(v) => onOpacityChange(v / 100)}
              disabled={!active}
              aria-label="Trade heatmap intensity"
              className="flex-1"
            />
            <span className="text-xs text-muted-foreground tabular-nums w-9 text-right">
              {Math.round(opacity * 100)}%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

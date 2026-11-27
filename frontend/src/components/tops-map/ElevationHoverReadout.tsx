import { useTranslation } from "@/lib/i18n";
import type { ElevationSample } from "@/lib/elevation/types";

interface ElevationHoverReadoutProps {
  /** The cursor's centered (TOPS) world coords, or null if outside the map. */
  hoverCoords: { x: number; z: number } | null;
  /** `elevationOverlay.sampleAt(x, z)` for the current cursor. */
  sample: ElevationSample | null;
  /** Floating bottom-left panel (fullscreen) instead of the inline card. */
  floating?: boolean;
}

/** Terrain height under the cursor while the elevation overlay is on. */
export function ElevationHoverReadout({
  hoverCoords,
  sample,
  floating = false,
}: ElevationHoverReadoutProps) {
  const { t } = useTranslation();
  const containerClass = floating
    ? "pointer-events-none absolute left-3 sm:left-6 bottom-6 sm:bottom-26 z-20 w-72 max-w-[calc(100vw-3rem)] rounded-md border bg-background/95 px-3 py-2 text-xs shadow-md backdrop-blur tabular-nums"
    : "rounded-md border px-3 py-2 text-xs tabular-nums";

  return (
    <div className={containerClass}>
      <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>{t("topsMap.elevationHoverTitle")}</span>
        <span>{hoverCoords ? `${hoverCoords.x}, ${hoverCoords.z}` : "—, —"}</span>
      </div>
      {hoverCoords && sample ? (
        <>
          <div className="mt-1 font-medium">
            {sample.isWater
              ? t("topsMap.elevationHoverWater", { depth: sample.depth, y: sample.y })
              : t("topsMap.elevationHoverLand", {
                  y: sample.y,
                  above: sample.aboveSea >= 0 ? `+${sample.aboveSea}` : sample.aboveSea,
                })}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {t("topsMap.elevationHoverResolution", { blocks: sample.resolutionBlocks })}
          </div>
        </>
      ) : (
        <div className="mt-1 text-muted-foreground">{t("topsMap.elevationHoverNoData")}</div>
      )}
    </div>
  );
}

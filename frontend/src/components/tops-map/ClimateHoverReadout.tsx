import { useTranslation } from "@/lib/i18n";
import type { ClimateLayerKind, CropId } from "@/lib/climate/types";
import type { ClimateSampleResult } from "@/hooks/useClimateOverlay";
import { CLIMATE_SEA_LEVEL } from "@/lib/climate/altitude";
import { coldestNight, hottestDay } from "@/lib/climate/extremes";

interface ClimateHoverReadoutProps {
  /** The cursor's centered (TOPS) world coords, or null if outside map. */
  hoverCoords: { x: number; z: number } | null;
  /** Result of `climateOverlay.sampleAt(x, z)` for the current cursor. */
  sample: ClimateSampleResult | null;
  /** Whether the climate overlay is visible. The readout is hidden when off. */
  visible: boolean;
  /** World Y the temperature/rainfall values are restated for. Shown as a
   *  hint when it differs from sea level so users know the numbers reflect
   *  their chosen build height, not the sea-level map colors. */
  altitudeY?: number;
  /** Render as a floating overlay panel pinned to the bottom-left of the
   *  parent (used in fullscreen mode), instead of the default inline
   *  block layout used inside the controls column. */
  floating?: boolean;
}

function unitForKind(kind: ClimateLayerKind): "C" | "unit" {
  if (kind === "rainfall" || kind === "geoactivity") return "unit";
  return "C";
}

function formatValue(kind: ClimateLayerKind, value: number): string {
  const unit = unitForKind(kind);
  if (unit === "C") {
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(1)}\u00B0C`;
  }
  return value.toFixed(3);
}

function layerLabel(kind: ClimateLayerKind, t: (k: never) => string): string {
  const tt = t as (k: string) => string;
  switch (kind) {
    case "tempavg":
      return tt("topsMap.climateTempAvg");
    case "tempmin":
      return tt("topsMap.climateTempMin");
    case "tempmax":
      return tt("topsMap.climateTempMax");
    case "rainfall":
      return tt("topsMap.climateRainfall");
    case "geoactivity":
      return tt("topsMap.climateGeoActivity");
  }
}

function cropLabel(id: CropId, t: (k: never) => string): string {
  const tt = t as (k: string) => string;
  switch (id) {
    case "amaranth":
      return tt("topsMap.climateCropAmaranth");
    case "bellpepper":
      return tt("topsMap.climateCropBellPepper");
    case "cabbage":
      return tt("topsMap.climateCropCabbage");
    case "carrot":
      return tt("topsMap.climateCropCarrot");
    case "cassava":
      return tt("topsMap.climateCropCassava");
    case "flax":
      return tt("topsMap.climateCropFlax");
    case "onion":
      return tt("topsMap.climateCropOnion");
    case "parsnip":
      return tt("topsMap.climateCropParsnip");
    case "peanut":
      return tt("topsMap.climateCropPeanut");
    case "pineapple":
      return tt("topsMap.climateCropPineapple");
    case "pumpkin":
      return tt("topsMap.climateCropPumpkin");
    case "rice":
      return tt("topsMap.climateCropRice");
    case "rye":
      return tt("topsMap.climateCropRye");
    case "soybean":
      return tt("topsMap.climateCropSoybean");
    case "spelt":
      return tt("topsMap.climateCropSpelt");
    case "sunflower":
      return tt("topsMap.climateCropSunflower");
    case "turnip":
      return tt("topsMap.climateCropTurnip");
    default:
      return "";
  }
}

/** Inline climate readout shown in the controls column. Displays the
 *  precise sampled value at the cursor's world position so users can
 *  verify the overlay against the in-game `/climate` command without
 *  leaving the site.
 */
export function ClimateHoverReadout({
  hoverCoords,
  sample,
  visible,
  altitudeY,
  floating = false,
}: ClimateHoverReadoutProps) {
  const { t } = useTranslation();
  if (!visible) return null;
  const tt = t as (k: string) => string;

  const primaryIsClimate = sample != null && sample.primary.kind !== "geoactivity";
  const showAltitude = altitudeY != null && altitudeY !== CLIMATE_SEA_LEVEL && primaryIsClimate;

  const containerClass = floating
    ? "pointer-events-none absolute left-3 sm:left-6 bottom-6 sm:bottom-26 z-20 w-72 max-w-[calc(100vw-3rem)] rounded-md border bg-background/95 px-3 py-2 text-xs shadow-md backdrop-blur tabular-nums"
    : "rounded-md border px-3 py-2 text-xs tabular-nums";

  return (
    <div className={containerClass}>
      <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>{tt("topsMap.climateReadout")}</span>
        <span>{hoverCoords ? `${hoverCoords.x}, ${hoverCoords.z}` : "—, —"}</span>
      </div>
      {showAltitude && (
        <div className="flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
          <span>{tt("topsMap.climateAtAltitude")}</span>
          <span className="tabular-nums">Y {altitudeY}</span>
        </div>
      )}
      {hoverCoords && sample ? (
        <>
          <div className="mt-1 flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">
              {layerLabel(sample.primary.kind, t as never)}
            </span>
            <span className="font-medium">
              {formatValue(sample.primary.kind, sample.primary.value)}
            </span>
          </div>
          {sample.primary.kind === "tempmin" && (
            <div className="flex items-baseline justify-between gap-3 text-[10px] text-muted-foreground">
              <span>{tt("topsMap.climateApproxNightLow")}</span>
              <span>{formatValue("tempmin", coldestNight(sample.primary.value))}</span>
            </div>
          )}
          {sample.primary.kind === "tempmax" && (
            <div className="flex items-baseline justify-between gap-3 text-[10px] text-muted-foreground">
              <span>{tt("topsMap.climateApproxDayHigh")}</span>
              <span>{formatValue("tempmax", hottestDay(sample.primary.value))}</span>
            </div>
          )}
          {sample.cropChecks && sample.cropChecks.length > 0 && (
            <div className="mt-1 border-t pt-1 flex flex-col gap-1.5">
              {sample.cropChecks.map((check) => {
                const coldNight = coldestNight(check.tempmin);
                const hotDay = hottestDay(check.tempmax);
                const coldOk = coldNight >= check.cropMin;
                const hotOk = hotDay <= check.cropMax;
                return (
                  <div key={check.cropId} className="flex flex-col gap-0.5">
                    {sample.cropChecks!.length > 1 && (
                      <span className="text-[10px] font-medium">
                        {cropLabel(check.cropId, t as never)}
                      </span>
                    )}
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-muted-foreground">
                        {tt("topsMap.climateApproxNightLow")}
                      </span>
                      <span className={coldOk ? "text-emerald-600" : "text-red-500"}>
                        {formatValue("tempmin", coldNight)}
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          {coldOk ? "\u2265" : "<"} {formatValue("tempmin", check.cropMin)}
                        </span>
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-muted-foreground">
                        {tt("topsMap.climateApproxDayHigh")}
                      </span>
                      <span className={hotOk ? "text-emerald-600" : "text-red-500"}>
                        {formatValue("tempmax", hotDay)}
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          {hotOk ? "\u2264" : ">"} {formatValue("tempmax", check.cropMax)}
                        </span>
                      </span>
                    </div>
                    <div className="text-[10px]">
                      {check.pass ? (
                        <span className="text-emerald-600">{tt("topsMap.climateCropPass")}</span>
                      ) : (
                        <span className="text-red-500">{tt("topsMap.climateCropFail")}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <div className="mt-1 text-muted-foreground">
          {hoverCoords ? tt("topsMap.climateReadoutLoading") : tt("topsMap.climateReadoutHint")}
        </div>
      )}
    </div>
  );
}

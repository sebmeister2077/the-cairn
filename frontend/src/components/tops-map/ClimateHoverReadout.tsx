import { useTranslation } from "@/lib/i18n";
import type { ClimateLayerKind } from "@/lib/climate/types";
import type { ClimateSampleResult } from "@/hooks/useClimateOverlay";

interface ClimateHoverReadoutProps {
  /** The cursor's centered (TOPS) world coords, or null if outside map. */
  hoverCoords: { x: number; z: number } | null;
  /** Result of `climateOverlay.sampleAt(x, z)` for the current cursor. */
  sample: ClimateSampleResult | null;
  /** Whether the climate overlay is visible. The readout is hidden when off. */
  visible: boolean;
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

/** Approximate diurnal swing applied to estimate an in-game winter-night
 *  low from the exporter's seasonal `tempmin` value. The exporter
 *  manifest documents that the raster excludes the diurnal swing
 *  (5..18 °C). We pick the middle of that range as a one-number
 *  estimate; it's labeled "approx" in the UI to set expectations. */
const APPROX_DIURNAL_NIGHT_OFFSET_C = 12;

/** Inline climate readout shown in the controls column. Displays the
 *  precise sampled value at the cursor's world position so users can
 *  verify the overlay against the in-game `/climate` command without
 *  leaving the site.
 */
export function ClimateHoverReadout({
  hoverCoords,
  sample,
  visible,
  floating = false,
}: ClimateHoverReadoutProps) {
  const { t } = useTranslation();
  if (!visible) return null;
  const tt = t as (k: string) => string;

  const containerClass = floating
    ? "pointer-events-none absolute left-6 bottom-26 z-20 w-72 max-w-[calc(100vw-3rem)] rounded-md border bg-background/95 px-3 py-2 text-xs shadow-md backdrop-blur tabular-nums"
    : "rounded-md border px-3 py-2 text-xs tabular-nums";

  return (
    <div className={containerClass}>
      <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>{tt("topsMap.climateReadout")}</span>
        <span>{hoverCoords ? `${hoverCoords.x}, ${hoverCoords.z}` : "—, —"}</span>
      </div>
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
              <span>
                {formatValue("tempmin", sample.primary.value - APPROX_DIURNAL_NIGHT_OFFSET_C)}
              </span>
            </div>
          )}
          {sample.cropCheck && (
            <div className="mt-1 border-t pt-1 flex flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">{tt("topsMap.climateTempMin")}</span>
                <span
                  className={
                    sample.cropCheck.tempmin >= sample.cropCheck.cropMin
                      ? "text-emerald-600"
                      : "text-red-500"
                  }
                >
                  {formatValue("tempmin", sample.cropCheck.tempmin)}
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    {sample.cropCheck.tempmin >= sample.cropCheck.cropMin ? "\u2265" : "<"}{" "}
                    {formatValue("tempmin", sample.cropCheck.cropMin)}
                  </span>
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3 text-[10px] text-muted-foreground">
                <span>{tt("topsMap.climateApproxNightLow")}</span>
                <span>
                  {formatValue("tempmin", sample.cropCheck.tempmin - APPROX_DIURNAL_NIGHT_OFFSET_C)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">{tt("topsMap.climateTempMax")}</span>
                <span
                  className={
                    sample.cropCheck.tempmax <= sample.cropCheck.cropMax
                      ? "text-emerald-600"
                      : "text-red-500"
                  }
                >
                  {formatValue("tempmax", sample.cropCheck.tempmax)}
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    {sample.cropCheck.tempmax <= sample.cropCheck.cropMax ? "\u2264" : ">"}{" "}
                    {formatValue("tempmax", sample.cropCheck.cropMax)}
                  </span>
                </span>
              </div>
              <div className="text-[10px] mt-0.5">
                {sample.cropCheck.pass ? (
                  <span className="text-emerald-600">{tt("topsMap.climateCropPass")}</span>
                ) : (
                  <span className="text-red-500">{tt("topsMap.climateCropFail")}</span>
                )}
              </div>
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

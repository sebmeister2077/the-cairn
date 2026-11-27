import { useCallback } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  setElevationEnabled as setElevationEnabledAction,
  setElevationMode as setElevationModeAction,
  setElevationBand as setElevationBandAction,
  setElevationOpacity as setElevationOpacityAction,
} from "@/store/slices/mapView";
import {
  ELEVATION_BAND_PRESETS,
  ELEVATION_LAND_STOPS,
  ELEVATION_WATER_DEEP,
  ELEVATION_WATER_SHALLOW,
  ELEVATION_Y_MAX,
  type ElevationMode,
} from "@/lib/elevation/types";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/helpers/utils";

interface ElevationPanelProps {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
}

/** Legend scale: Y 50 (deep water) .. 254 (peaks). */
const LEGEND_MIN_Y = 50;
const WATER_SURFACE_Y = 109;

function ReliefLegend() {
  const { t } = useTranslation();
  const span = ELEVATION_Y_MAX - LEGEND_MIN_Y;
  const pct = (y: number) => (((y - LEGEND_MIN_Y) / span) * 100).toFixed(2);
  const stops = [
    `${ELEVATION_WATER_DEEP} 0%`,
    `${ELEVATION_WATER_SHALLOW} ${pct(WATER_SURFACE_Y)}%`,
    ...ELEVATION_LAND_STOPS.map((s) => `${s.hex} ${pct(s.y)}%`),
  ].join(", ");
  return (
    <div className="flex flex-col gap-1">
      <div
        className="h-2 w-full rounded-sm border"
        style={{ background: `linear-gradient(to right, ${stops})` }}
        aria-hidden
      />
      <div className="relative h-3 text-[10px] text-muted-foreground tabular-nums">
        {[
          { y: LEGEND_MIN_Y, label: String(LEGEND_MIN_Y) },
          { y: 110, label: `110 ${t("topsMap.elevationSeaLevel")}` },
          { y: 175, label: "175" },
          { y: ELEVATION_Y_MAX, label: String(ELEVATION_Y_MAX) },
        ].map((tick, i, all) => (
          <span
            key={tick.y}
            className="absolute"
            style={{
              left: `${pct(tick.y)}%`,
              transform:
                i === 0 ? undefined : i === all.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Toggle, relief/band mode, band range + presets and opacity for the
 *  terrain elevation overlay. */
export function ElevationPanel({ status, error }: ElevationPanelProps) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();

  const enabled = useAppSelector((s) => s.mapView.elevationEnabled);
  const mode = useAppSelector((s) => s.mapView.elevationMode);
  const bandMin = useAppSelector((s) => s.mapView.elevationBandMin);
  const bandMax = useAppSelector((s) => s.mapView.elevationBandMax);
  const opacity = useAppSelector((s) => s.mapView.elevationOpacity);

  const setEnabled = useCallback(
    (next: boolean) => dispatch(setElevationEnabledAction(next)),
    [dispatch],
  );
  const setMode = useCallback(
    (next: ElevationMode) => dispatch(setElevationModeAction(next)),
    [dispatch],
  );
  const setBand = useCallback(
    (min: number, max: number) => dispatch(setElevationBandAction({ min, max })),
    [dispatch],
  );
  const setOpacity = useCallback(
    (next: number) => dispatch(setElevationOpacityAction(next)),
    [dispatch],
  );

  return (
    <div className="flex flex-col rounded-md border bg-background/95 px-3 py-2 text-sm shadow-md backdrop-blur">
      <div className="cursor-pointer flex items-center gap-2" onClick={() => setEnabled(!enabled)}>
        <Switch checked={enabled} aria-label={t("topsMap.elevation")} />
        <Label className="cursor-pointer">{t("topsMap.elevation")}</Label>
        {status === "loading" && enabled && (
          <span className="text-xs text-muted-foreground ml-1">…</span>
        )}
        {status === "error" && error && (
          <span className="text-xs text-red-500 ml-1 truncate" title={error}>
            {error}
          </span>
        )}
      </div>

      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: enabled ? "1fr" : "0fr" }}
        aria-hidden={!enabled}
        inert={!enabled}
      >
        <div className="overflow-hidden min-h-0">
          <div className="flex flex-col gap-2 pt-2">
            <div className="flex rounded-md border p-0.5">
              {(["relief", "band"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={cn(
                    "flex-1 cursor-pointer rounded px-2 py-1 text-xs transition-colors",
                    mode === m ? "bg-foreground text-background" : "hover:bg-muted",
                  )}
                >
                  {m === "relief" ? t("topsMap.elevationRelief") : t("topsMap.elevationBand")}
                </button>
              ))}
            </div>

            {mode === "relief" ? (
              <ReliefLegend />
            ) : (
              <>
                <div className="flex flex-wrap gap-1">
                  {ELEVATION_BAND_PRESETS.map((p) => {
                    const active = bandMin === p.min && bandMax === p.max;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setBand(p.min, p.max)}
                        className={cn(
                          "cursor-pointer rounded border px-2 py-0.5 text-[11px] transition-colors",
                          active ? "bg-foreground text-background" : "hover:bg-muted",
                        )}
                        title={`Y ${p.min}–${p.max}`}
                      >
                        {t(`topsMap.elevationPresets.${p.id}` as "topsMap.elevationPresets.rapids")}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground w-12 shrink-0">
                    {t("topsMap.elevationBandMin")}
                  </span>
                  <Slider
                    value={bandMin}
                    min={0}
                    max={ELEVATION_Y_MAX}
                    step={1}
                    onValueChange={(v) => setBand(Math.min(v, bandMax), bandMax)}
                    aria-label={t("topsMap.elevationBandMin")}
                    className="flex-1"
                    disabled={!enabled}
                  />
                  <span className="text-[10px] text-muted-foreground tabular-nums w-8 text-right">
                    {bandMin}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground w-12 shrink-0">
                    {t("topsMap.elevationBandMax")}
                  </span>
                  <Slider
                    value={bandMax}
                    min={0}
                    max={ELEVATION_Y_MAX}
                    step={1}
                    onValueChange={(v) => setBand(bandMin, Math.max(v, bandMin))}
                    aria-label={t("topsMap.elevationBandMax")}
                    className="flex-1"
                    disabled={!enabled}
                  />
                  <span className="text-[10px] text-muted-foreground tabular-nums w-8 text-right">
                    {bandMax}
                  </span>
                </div>
              </>
            )}

            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-12 shrink-0">
                {t("topsMap.elevationOpacity")}
              </span>
              <Slider
                value={Math.round(opacity * 100)}
                min={0}
                max={100}
                step={5}
                onValueChange={(v) => setOpacity(v / 100)}
                aria-label={t("topsMap.elevationOpacity")}
                className="flex-1"
                disabled={!enabled}
              />
              <span className="text-[10px] text-muted-foreground tabular-nums w-8 text-right">
                {Math.round(opacity * 100)}%
              </span>
            </div>

            <p className="text-[11px] text-muted-foreground leading-snug">
              {t("topsMap.elevationNote")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

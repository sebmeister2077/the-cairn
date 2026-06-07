import { useCallback, useMemo } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  setClimateSubToggle as setClimateSubToggleAction,
  setClimateTempVariant as setClimateTempVariantAction,
  setClimateThresholdMode as setClimateThresholdModeAction,
  setClimateCustomRange as setClimateCustomRangeAction,
  setClimateOpacity as setClimateOpacityAction,
} from "@/store/slices/mapView";
import type {
  ClimateLayerMeta,
  ClimateSubToggle,
  ClimateTempVariant,
  ClimateThresholdMode,
} from "@/lib/climate/types";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface ClimateControlsPanelProps {
  /** Per-layer metadata (anchors + stats) for the active layer.
   *  `null` while the overlay is disabled or still loading. */
  layerMeta: ClimateLayerMeta | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
}

interface PresetSpec {
  id: ClimateThresholdMode;
  /** Variant the preset locks to (for chip-active highlighting). */
  variant: ClimateTempVariant;
}

const PRESETS: PresetSpec[] = [
  { id: "year_round_5", variant: "tempmin" },
  { id: "frost_free_0", variant: "tempmin" },
  { id: "tropical_10", variant: "tempmin" },
  { id: "temperate_band", variant: "tempavg" },
];

function presetLabel(id: ClimateThresholdMode, t: (k: never) => string): string {
  // Local switch keeps the i18n path literals visible to the type system —
  // `t()` is a strict generic that won't accept a `string` variable.
  // The cast on `t` lets each branch pass its own literal key safely.
  const tt = t as (k: string) => string;
  switch (id) {
    case "year_round_5":
      return tt("topsMap.climatePresetYearRound");
    case "frost_free_0":
      return tt("topsMap.climatePresetFrostFree");
    case "tropical_10":
      return tt("topsMap.climatePresetTropical");
    case "temperate_band":
      return tt("topsMap.climatePresetTemperate");
    default:
      return "";
  }
}

function presetHint(id: ClimateThresholdMode, t: (k: never) => string): string {
  const tt = t as (k: string) => string;
  switch (id) {
    case "year_round_5":
      return tt("topsMap.climatePresetYearRoundHint");
    case "frost_free_0":
      return tt("topsMap.climatePresetFrostFreeHint");
    case "tropical_10":
      return tt("topsMap.climatePresetTropicalHint");
    case "temperate_band":
      return tt("topsMap.climatePresetTemperateHint");
    default:
      return "";
  }
}

function GradientLegend({ meta }: { meta: ClimateLayerMeta }) {
  // Build a CSS gradient that matches the per-layer color anchors. Anchors
  // span the layer's full conceptual range (e.g. -50..60 °C) — we squeeze
  // them into the visible swatch by linearly mapping anchor values to 0..100%.
  const anchors = meta.colorAnchors;
  if (anchors.length === 0) return null;
  const lo = anchors[0].value;
  const hi = anchors[anchors.length - 1].value;
  const span = hi - lo;
  const stops = anchors
    .map((a) => {
      const pct = span > 0 ? ((a.value - lo) / span) * 100 : 0;
      return `${a.hex} ${pct.toFixed(2)}%`;
    })
    .join(", ");
  const { stats } = meta;
  return (
    <div className="flex flex-col gap-1">
      <div
        className="h-2 w-full rounded-sm border"
        style={{ background: `linear-gradient(to right, ${stops})` }}
        aria-hidden
      />
      <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{stats.min.toFixed(1)}</span>
        <span>{stats.avg.toFixed(1)}</span>
        <span>{stats.max.toFixed(1)}</span>
      </div>
    </div>
  );
}

function NumberField({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
  placeholder?: string;
  ariaLabel: string;
}) {
  return (
    <input
      type="number"
      step="0.5"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") {
          onChange(null);
          return;
        }
        const n = parseFloat(raw);
        onChange(Number.isFinite(n) ? n : null);
      }}
      aria-label={ariaLabel}
      className="w-20 rounded border bg-background px-2 py-0.5 text-xs tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

export function ClimateControlsPanel({ layerMeta, status, error }: ClimateControlsPanelProps) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();

  const subToggle = useAppSelector((s) => s.mapView.climateSubToggle);
  const tempVariant = useAppSelector((s) => s.mapView.climateTempVariant);
  const thresholdMode = useAppSelector((s) => s.mapView.climateThresholdMode);
  const customMin = useAppSelector((s) => s.mapView.climateCustomMin);
  const customMax = useAppSelector((s) => s.mapView.climateCustomMax);
  const opacity = useAppSelector((s) => s.mapView.climateOpacity);

  const setSubToggle = useCallback(
    (next: ClimateSubToggle) => dispatch(setClimateSubToggleAction(next)),
    [dispatch],
  );
  const setTempVariant = useCallback(
    (next: ClimateTempVariant) => dispatch(setClimateTempVariantAction(next)),
    [dispatch],
  );
  const setThresholdMode = useCallback(
    (next: ClimateThresholdMode) => dispatch(setClimateThresholdModeAction(next)),
    [dispatch],
  );
  const setCustomRange = useCallback(
    (min: number | null, max: number | null) =>
      dispatch(setClimateCustomRangeAction({ min, max })),
    [dispatch],
  );
  const setOpacity = useCallback(
    (next: number) => dispatch(setClimateOpacityAction(next)),
    [dispatch],
  );

  const enabled = subToggle !== "off";

  // Master switch: toggling on defaults to Temperature (most useful for
  // the crop-friendly preset chips). Toggling off resets to "off".
  const onMasterToggle = useCallback(
    (next: boolean) => {
      setSubToggle(next ? "temperature" : "off");
    },
    [setSubToggle],
  );

  const isTempMode = subToggle === "temperature";
  const tempActive = useMemo(
    () =>
      isTempMode
        ? thresholdMode === "year_round_5" ||
          thresholdMode === "frost_free_0" ||
          thresholdMode === "tropical_10" ||
          thresholdMode === "temperate_band"
        : false,
    [isTempMode, thresholdMode],
  );

  const togglePreset = useCallback(
    (id: ClimateThresholdMode) => {
      // Click the active chip a second time to clear it.
      setThresholdMode(thresholdMode === id ? "none" : id);
    },
    [thresholdMode, setThresholdMode],
  );

  return (
    <div className="flex flex-col rounded-md border bg-background/95 px-3 py-2 text-sm shadow-md backdrop-blur gap-2">
      {/* Master row */}
      <div
        className="cursor-pointer flex items-center gap-2"
        onClick={() => onMasterToggle(!enabled)}
      >
        <Switch checked={enabled} aria-label={t("topsMap.climate")} />
        <Label className="cursor-pointer">{t("topsMap.climate")}</Label>
        {status === "loading" && enabled && (
          <span className="text-xs text-muted-foreground ml-1">…</span>
        )}
        {status === "error" && error && (
          <span className="text-xs text-red-500 ml-1 truncate" title={error}>
            {error}
          </span>
        )}
      </div>

      {/* Sub-toggle radio */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: enabled ? "1fr" : "0fr" }}
        aria-hidden={!enabled}
      >
        <div className="overflow-hidden min-h-0">
          <div className="flex flex-col gap-2 pt-1">
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t("topsMap.climate")}>
              {(["geoactivity", "rainfall", "temperature"] as ClimateSubToggle[]).map((id) => {
                const active = subToggle === id;
                const labelKey =
                  id === "geoactivity"
                    ? "topsMap.climateGeoActivity"
                    : id === "rainfall"
                      ? "topsMap.climateRainfall"
                      : "topsMap.climateTemperature";
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    tabIndex={enabled ? 0 : -1}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setSubToggle(id);
                    }}
                    className={cn(
                      "select-none rounded-full border px-2 py-0.5 text-xs cursor-pointer transition-colors duration-150",
                      active ? "bg-foreground text-background" : "bg-background hover:bg-muted",
                    )}
                  >
                    {t(labelKey)}
                  </button>
                );
              })}
            </div>

            {/* Temperature-specific controls */}
            {isTempMode && (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] text-muted-foreground leading-snug">
                  {t("topsMap.climateTemperatureHint")}
                </p>
                {/* Variant radio */}
                <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t("topsMap.climateTemperatureVariant")}>
                  {(["tempavg", "tempmin", "tempmax"] as ClimateTempVariant[]).map((v) => {
                    const active = tempVariant === v;
                    const labelKey =
                      v === "tempavg"
                        ? "topsMap.climateTempAvg"
                        : v === "tempmin"
                          ? "topsMap.climateTempMin"
                          : "topsMap.climateTempMax";
                    return (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setTempVariant(v);
                          // Switching variant out from under a preset would mismatch
                          // — clear the threshold so the panel state stays consistent.
                          if (
                            thresholdMode !== "none" &&
                            thresholdMode !== "custom" &&
                            !PRESETS.find((p) => p.id === thresholdMode && p.variant === v)
                          ) {
                            setThresholdMode("none");
                          }
                        }}
                        className={cn(
                          "select-none rounded border px-2 py-0.5 text-[11px] cursor-pointer transition-colors duration-150",
                          active ? "bg-foreground text-background" : "bg-background hover:bg-muted",
                        )}
                      >
                        {t(labelKey)}
                      </button>
                    );
                  })}
                </div>

                {/* Crop preset chips */}
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {t("topsMap.climatePresets")}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {PRESETS.map((p) => {
                      const active = thresholdMode === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          aria-pressed={active}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            togglePreset(p.id);
                          }}
                          title={presetHint(p.id, t as never)}
                          className={cn(
                            "select-none rounded-full border px-2 py-0.5 text-xs cursor-pointer transition-colors duration-150",
                            active
                              ? "bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700"
                              : "bg-background hover:bg-muted",
                          )}
                        >
                          {presetLabel(p.id, t as never)}
                        </button>
                      );
                    })}
                    {tempActive && (
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setThresholdMode("none");
                        }}
                        className="select-none rounded-full border px-2 py-0.5 text-xs cursor-pointer text-muted-foreground hover:bg-muted"
                      >
                        {t("topsMap.climateClearPreset")}
                      </button>
                    )}
                  </div>
                </div>

                {/* Custom range */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t("topsMap.climateCustomRange")}
                    </span>
                    {thresholdMode === "custom" && (
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setThresholdMode("none");
                          setCustomRange(null, null);
                        }}
                        className="text-[10px] text-muted-foreground hover:text-foreground underline"
                      >
                        {t("topsMap.climateClearPreset")}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{t("topsMap.climateThresholdMin")}</span>
                    <NumberField
                      value={customMin}
                      onChange={(next) => {
                        setCustomRange(next, customMax);
                        if (next != null || customMax != null) setThresholdMode("custom");
                      }}
                      placeholder="−"
                      ariaLabel={t("topsMap.climateThresholdMin")}
                    />
                    <span>{t("topsMap.climateThresholdMax")}</span>
                    <NumberField
                      value={customMax}
                      onChange={(next) => {
                        setCustomRange(customMin, next);
                        if (next != null || customMin != null) setThresholdMode("custom");
                      }}
                      placeholder="+"
                      ariaLabel={t("topsMap.climateThresholdMax")}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Legend gradient + opacity (shared across all sub-toggles) */}
            {layerMeta && <GradientLegend meta={layerMeta} />}

            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-12 shrink-0">
                {t("topsMap.climateOpacity")}
              </span>
              <Slider
                value={Math.round(opacity * 100)}
                min={0}
                max={100}
                step={5}
                onValueChange={(v) => setOpacity(v / 100)}
                aria-label={t("topsMap.climateOpacity")}
                className="flex-1"
              />
              <span className="text-[10px] text-muted-foreground tabular-nums w-8 text-right">
                {Math.round(opacity * 100)}%
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

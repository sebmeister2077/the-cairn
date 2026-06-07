import { useCallback, useMemo } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  setClimateSubToggle as setClimateSubToggleAction,
  setClimateTempVariant as setClimateTempVariantAction,
  setClimateThresholdMode as setClimateThresholdModeAction,
  setClimateCropId as setClimateCropIdAction,
  setClimateCustomRange as setClimateCustomRangeAction,
  setClimateOpacity as setClimateOpacityAction,
} from "@/store/slices/mapView";
import {
  CROPS,
  type ClimateLayerMeta,
  type ClimateSubToggle,
  type ClimateTempVariant,
  type ClimateThresholdMode,
  type CropId,
  type CropTolerance,
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

function cropLabel(id: CropId, t: (k: never) => string): string {
  // Local switch keeps the i18n path literals visible to the type system —
  // `t()` is a strict generic that won't accept a `string` variable.
  // The cast on `t` lets each branch pass its own literal key safely.
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

function formatTempRange(crop: CropTolerance): string {
  const fmt = (n: number) => `${n > 0 ? "+" : ""}${n}\u00B0C`;
  return `${fmt(crop.minTempC)} \u2026 ${fmt(crop.maxTempC)}`;
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
  const cropId = useAppSelector((s) => s.mapView.climateCropId);
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
  const setCropId = useCallback(
    (next: CropId | null) => dispatch(setClimateCropIdAction(next)),
    [dispatch],
  );
  const setCustomRange = useCallback(
    (min: number | null, max: number | null) => dispatch(setClimateCustomRangeAction({ min, max })),
    [dispatch],
  );
  const setOpacity = useCallback(
    (next: number) => dispatch(setClimateOpacityAction(next)),
    [dispatch],
  );

  const enabled = subToggle !== "off";

  // Master switch: toggling on defaults to Temperature (most useful for
  // the crop-friendly chips). Toggling off resets to "off".
  const onMasterToggle = useCallback(
    (next: boolean) => {
      setSubToggle(next ? "temperature" : "off");
    },
    [setSubToggle],
  );

  const isTempMode = subToggle === "temperature";
  const cropActive = thresholdMode === "crop" && cropId != null;

  const toggleCrop = useCallback(
    (id: CropId) => {
      // Click the active chip a second time to clear it.
      setCropId(cropId === id ? null : id);
    },
    [cropId, setCropId],
  );

  // CROPS is already alphabetical by id; keep it as-is for stable ordering.
  const sortedCrops = useMemo(() => CROPS, []);

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
            <div
              className="flex flex-wrap gap-1"
              role="radiogroup"
              aria-label={t("topsMap.climate")}
            >
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
                <div
                  className="flex flex-wrap gap-1"
                  role="radiogroup"
                  aria-label={t("topsMap.climateTemperatureVariant")}
                >
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
                          // The crop mask is variant-independent (it always
                          // uses tempmin + tempmax internally), so changing
                          // which gradient is shown as the legend does NOT
                          // disturb the selected crop.
                          setTempVariant(v);
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

                {/* Crop chips */}
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {t("topsMap.climateCropTitle")}
                  </span>
                  <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto pr-1">
                    {sortedCrops.map((crop) => {
                      const active = cropId === crop.id;
                      const isLinen = crop.kind === "linen";
                      const label = cropLabel(crop.id, t as never);
                      const tooltip = `${label} \u2014 ${formatTempRange(crop)}${
                        isLinen
                          ? ` (${(t as (k: string) => string)("topsMap.climateCropLinenTag")})`
                          : ""
                      }`;
                      return (
                        <button
                          key={crop.id}
                          type="button"
                          aria-pressed={active}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            toggleCrop(crop.id);
                          }}
                          title={tooltip}
                          className={cn(
                            "select-none rounded-full border px-2 py-0.5 text-xs cursor-pointer transition-colors duration-150",
                            active && isLinen
                              ? "bg-sky-600 text-white border-sky-700 hover:bg-sky-700"
                              : active
                                ? "bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700"
                                : "bg-background hover:bg-muted",
                            isLinen && !active && "italic",
                          )}
                        >
                          {label}
                          {isLinen && (
                            <span className="ml-1 text-[9px] opacity-70 align-middle">
                              {t("topsMap.climateCropLinenTag")}
                            </span>
                          )}
                        </button>
                      );
                    })}
                    {cropActive && (
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setCropId(null);
                        }}
                        className="select-none rounded-full border px-2 py-0.5 text-xs cursor-pointer text-muted-foreground hover:bg-muted"
                      >
                        {t("topsMap.climateClearPreset")}
                      </button>
                    )}
                  </div>
                  {cropActive && (
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {formatTempRange(sortedCrops.find((c) => c.id === cropId) ?? sortedCrops[0])}
                    </span>
                  )}
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

import { useCallback, useMemo } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import type { LegendEntry, RockStrataLayerKind } from "@/lib/rockstrata/types";
import { isLayerAvailable } from "@/lib/rockstrata/loader";
import { cn } from "@/lib/utils";

interface RockStrataLegendPanelProps {
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  layerKind: RockStrataLayerKind;
  onLayerKindChange: (next: RockStrataLayerKind) => void;
  halfBlocks: number;
  onHalfBlocksChange: (next: number) => void;
  /** Overlay opacity, 0..1. */
  opacity: number;
  onOpacityChange: (next: number) => void;
  /** `null` = all codes kept. */
  keepCodes: string[] | null;
  onKeepCodesChange: (next: string[] | null) => void;
  legend: LegendEntry[] | null;
  warnBlocky: boolean;
  sourceBlocksPerPixel: number | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
}

const HALF_BLOCKS_MIN = 1000;
const HALF_BLOCKS_MAX = 12000;
const HALF_BLOCKS_STEP = 500;

export function RockStrataLegendPanel({
  enabled,
  onEnabledChange,
  layerKind,
  onLayerKindChange,
  halfBlocks,
  onHalfBlocksChange,
  opacity,
  onOpacityChange,
  keepCodes,
  onKeepCodesChange,
  legend,
  warnBlocky,
  sourceBlocksPerPixel,
  status,
  error,
}: RockStrataLegendPanelProps) {
  const { t } = useTranslation();
  const geoAvailable = isLayerAvailable("geo");

  const allCodes = useMemo(() => legend?.map((e) => e.code) ?? [], [legend]);
  const keptSet = useMemo(
    () => (keepCodes == null ? new Set(allCodes) : new Set(keepCodes)),
    [keepCodes, allCodes],
  );

  const toggleCode = useCallback(
    (code: string) => {
      const next = new Set(keptSet);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      onKeepCodesChange(Array.from(next));
    },
    [keptSet, onKeepCodesChange],
  );

  const selectAll = useCallback(() => onKeepCodesChange(null), [onKeepCodesChange]);
  const clearAll = useCallback(() => onKeepCodesChange([]), [onKeepCodesChange]);

  return (
    <div className="flex flex-col rounded-md border px-3 py-2 text-sm gap-3">
      <div className="flex items-center gap-2">
        <Switch
          checked={enabled}
          onCheckedChange={onEnabledChange}
          aria-label={t("topsMap.showRockStrataOverlay")}
        />
        <Label>{t("topsMap.rockStrata")}</Label>
        {status === "loading" && enabled && (
          <span className="text-xs text-muted-foreground ml-2">…</span>
        )}
        {status === "error" && error && (
          <span className="text-xs text-red-500 ml-2 truncate" title={error}>
            {error}
          </span>
        )}
      </div>

      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: enabled ? "1fr" : "0fr" }}
        aria-hidden={!enabled}
      >
        <div className="overflow-hidden min-h-0">
          <div className="flex flex-col gap-3 pt-1">
            {/* Layer kind */}
            <div className="flex items-center gap-3 text-xs">
              <span className="text-muted-foreground">{t("topsMap.rockStrataKind")}</span>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="rockstrata-kind"
                  checked={layerKind === "rock"}
                  onChange={() => onLayerKindChange("rock")}
                />
                <span>{t("topsMap.rockStrataKindRock")}</span>
              </label>
              <label
                className={cn(
                  "flex items-center gap-1",
                  geoAvailable ? "cursor-pointer" : "cursor-not-allowed opacity-60",
                )}
                title={geoAvailable ? undefined : t("topsMap.rockStrataKindGeoUnavailable")}
              >
                <input
                  type="radio"
                  name="rockstrata-kind"
                  checked={layerKind === "geo"}
                  onChange={() => onLayerKindChange("geo")}
                  disabled={!geoAvailable}
                />
                <span>{t("topsMap.rockStrataKindGeo")}</span>
              </label>
            </div>

            {/* Half-size slider */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <Label className="text-xs">{t("topsMap.rockStrataDisplaySize")}</Label>
                <span className="font-medium text-foreground tabular-nums">
                  {(halfBlocks * 2).toLocaleString()} {t("topsMap.blocks")}
                </span>
              </div>
              <Slider
                value={halfBlocks}
                min={HALF_BLOCKS_MIN}
                max={HALF_BLOCKS_MAX}
                step={HALF_BLOCKS_STEP}
                onValueChange={onHalfBlocksChange}
              />
            </div>

            {/* Opacity slider */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <Label className="text-xs">{t("topsMap.rockStrataOpacity")}</Label>
                <span className="font-medium text-foreground tabular-nums">
                  {Math.round(opacity * 100)}%
                </span>
              </div>
              <Slider
                value={Math.round(opacity * 100)}
                min={0}
                max={100}
                step={5}
                onValueChange={(v) => onOpacityChange(v / 100)}
              />
            </div>

            {/* Blocky warning */}
            {warnBlocky && sourceBlocksPerPixel != null && (
              <div className="rounded-md border border-amber-500/50 bg-amber-50/30 dark:bg-amber-500/10 px-2 py-1.5 text-xs text-amber-900 dark:text-amber-200">
                {t("topsMap.rockStrataBlockyWarning", {
                  bpp: sourceBlocksPerPixel.toLocaleString(),
                })}
              </div>
            )}

            {/* Legend chips — same chip pattern as the trader filter so the
                two filtering UIs feel consistent. */}
            {legend && legend.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {t("topsMap.rockStrataLegendTitle")}
                  </span>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs"
                      onClick={selectAll}
                    >
                      {t("topsMap.rockStrataSelectAll")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs"
                      onClick={clearAll}
                    >
                      {t("topsMap.rockStrataClearAll")}
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1 max-h-72 overflow-y-auto pr-1">
                  {legend.map((e, i) => {
                    const active = keptSet.has(e.code);
                    return (
                      <button
                        key={e.code}
                        type="button"
                        onClick={() => toggleCode(e.code)}
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-xs cursor-pointer",
                          "animate-in fade-in-0 slide-in-from-top-1 fill-mode-both",
                          "transition-colors duration-150",
                          active ? "bg-foreground text-background" : "bg-background",
                        )}
                        style={{
                          borderColor: e.hexcolor,
                          animationDelay: `${i * 15}ms`,
                          animationDuration: "260ms",
                        }}
                        aria-pressed={active}
                        title={`${e.code} — ${e.pixelCount.toLocaleString()}`}
                      >
                        <span
                          aria-hidden
                          className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                          style={{ backgroundColor: e.hexcolor }}
                        />
                        {e.code}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

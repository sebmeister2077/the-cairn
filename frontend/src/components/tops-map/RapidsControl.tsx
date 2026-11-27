import { useCallback, useMemo } from "react";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Slider } from "../ui/slider";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  setShowRapids as setShowRapidsAction,
  setRapidsShowPredicted as setRapidsShowPredictedAction,
  setRapidsMinLikelihood as setRapidsMinLikelihoodAction,
  setRapidsShowClaimed as setRapidsShowClaimedAction,
} from "@/store/slices/mapView";
import { useRapidsOverlay } from "@/hooks/useRapidsOverlay";
import { filterRapids } from "@/lib/tops-map-view/rapids-clusters";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/helpers/utils";

interface RapidsControlProps {
  /** `"card"` for the controls column, `"fullscreen"` for the floating stack. */
  variant?: "card" | "fullscreen";
}

/**
 * Toggle + filters for the combined Rapids overlay (recorded + generated).
 * Self-contained (reads/writes the `mapView` slice and shares the page's
 * rapids query for the counts), so the controls column and the fullscreen
 * overlay render the same panel.
 */
export function RapidsControl({ variant = "card" }: RapidsControlProps) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const fullscreen = variant === "fullscreen";

  const showAdvancedMapOptions = useAppSelector((s) => s.mapView.showAdvancedMapOptions);
  const showRapids = useAppSelector((s) => s.mapView.showRapids);
  const showPredicted = useAppSelector((s) => s.mapView.rapidsShowPredicted);
  const minLikelihood = useAppSelector((s) => s.mapView.rapidsMinLikelihood);
  const showClaimed = useAppSelector((s) => s.mapView.rapidsShowClaimed);

  const setShowRapids = useCallback(
    (next: boolean) => dispatch(setShowRapidsAction(next)),
    [dispatch],
  );
  const setShowPredicted = useCallback(
    (next: boolean) => dispatch(setRapidsShowPredictedAction(next)),
    [dispatch],
  );
  const setMinLikelihood = useCallback(
    (next: number) => dispatch(setRapidsMinLikelihoodAction(next)),
    [dispatch],
  );
  const setShowClaimed = useCallback(
    (next: boolean) => dispatch(setRapidsShowClaimedAction(next)),
    [dispatch],
  );

  const rapidsQuery = useRapidsOverlay(showAdvancedMapOptions && showRapids);
  const data = rapidsQuery.data;
  const shownCount = useMemo(
    () =>
      data
        ? filterRapids(data.markers, { showPredicted, minLikelihood, showClaimed }).length
        : 0,
    [data, showPredicted, minLikelihood, showClaimed],
  );

  if (!showAdvancedMapOptions) return null;

  const pct = Math.round(minLikelihood * 100);

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border px-3 py-2 text-sm",
        fullscreen && "bg-background/95 shadow-md backdrop-blur",
      )}
    >
      <div
        onClick={() => setShowRapids(!showRapids)}
        className="cursor-pointer flex items-center gap-2"
      >
        <Switch checked={showRapids} aria-label={t("topsMap.showRapidsOverlay")} />
        <Label className="cursor-pointer">{t("topsMap.showRapids")}</Label>
        <span className="text-xs text-muted-foreground">
          {t("topsMap.totalCount", { count: (data?.counts.total ?? 0).toLocaleString() })}
        </span>
      </div>
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: showRapids ? "1fr" : "0fr" }}
        aria-hidden={!showRapids}
        inert={!showRapids}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-2 pt-1">
            {data && (
              <span className="text-[11px] text-muted-foreground leading-snug">
                {t("topsMap.rapidsBreakdown", {
                  confirmed: data.counts.confirmed.toLocaleString(),
                  recorded: data.counts.recordedOnly.toLocaleString(),
                  predicted: data.counts.predicted.toLocaleString(),
                })}
                {" · "}
                <span className="font-medium text-foreground">
                  {t("topsMap.rapidsShowing", { count: shownCount.toLocaleString() })}
                </span>
              </span>
            )}
            <div
              className="cursor-pointer flex items-center gap-2"
              onClick={() => setShowPredicted(!showPredicted)}
            >
              <Switch
                checked={showPredicted}
                aria-label={t("topsMap.rapidsShowPredicted")}
                className="scale-90"
              />
              <Label className="cursor-pointer text-xs">{t("topsMap.rapidsShowPredicted")}</Label>
            </div>
            <div className={cn("flex items-center gap-2", !showPredicted && "opacity-50")}>
              <span className="text-[10px] text-muted-foreground w-20 shrink-0">
                {t("topsMap.rapidsMinLikelihood")}
              </span>
              <Slider
                value={pct}
                min={0}
                max={100}
                step={25}
                onValueChange={(v) => setMinLikelihood(v / 100)}
                aria-label={t("topsMap.rapidsMinLikelihood")}
                className="flex-1"
                disabled={!showPredicted}
              />
              <span className="text-[10px] text-muted-foreground tabular-nums w-14 text-right">
                {pct >= 100 ? t("topsMap.rapidsCertainOnly") : `≥ ${pct}%`}
              </span>
            </div>
            <div
              className="cursor-pointer flex items-center gap-2"
              onClick={() => setShowClaimed(!showClaimed)}
            >
              <Switch
                checked={showClaimed}
                aria-label={t("topsMap.rapidsShowClaimed")}
                className="scale-90"
              />
              <Label className="cursor-pointer text-xs">{t("topsMap.rapidsShowClaimed")}</Label>
            </div>
            {data?.scanRadiusBlocks != null && (
              <p className="text-[11px] text-muted-foreground leading-snug">
                {t("topsMap.rapidsNote", { radius: data.scanRadiusBlocks.toLocaleString() })}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

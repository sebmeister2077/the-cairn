import { Layers, Minimize2, Search, Waypoints } from "lucide-react";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Combobox } from "../ui/combobox";
import { useAppDispatch, useAppSelector, useReduxState } from "@/store/hooks";
import { useCallback, useMemo, useState } from "react";
import {
  setSelectedLevel as setSelectedLevelAction,
  setGroupingsViewMode as setGroupingsViewModeAction,
  setActiveGroupingIds as setActiveGroupingIdsAction,
  toggleActiveGrouping as toggleActiveGroupingAction,
  setShowLandmarks as setShowLandmarksAction,
  setShowTerminus as setShowTerminusAction,
  setShowTranslocators as setShowTranslocatorsAction,
  setShowTraders as setShowTradersAction,
  setShowOceans as setShowOceansAction,
  toggleTraderTypeFilter as toggleTraderTypeFilterAction,
  setShowFullscreen as setShowFullscreenAction,
  toggleShowRecentlyAdded as toggleShowRecentlyAddedAction,
} from "@/store/slices/mapView";
import { setRoutePlannerOpen } from "@/store/slices/routePlanner";
import { formatDuration } from "@/lib/format-duration";
import { useTranslation } from "@/lib/i18n";

// Static count of ocean bodies in the canonical server snapshot
// (`frontend/src/assets/Oceans/oceans.json` -> `bodies.length`). Hardcoded
// because server size is fixed and we don't want to ship the ~1 MB JSON
// to clients just to read its length.
const OCEANS_TOTAL_COUNT = 1236;
import {
  TRADER_TYPES,
  TRADER_TYPE_LABELS,
  TRADER_TYPE_COLORS,
  type TraderType,
} from "@/lib/trader-types";
import { HomePositionControls } from "./HomePositionControls";
import { cn } from "@/lib/utils";

type FullscreenControlsOverlayProps = {
  translocatorCount: number;
  visibleTranslocatorCount: number;
  filteringActive: boolean;
  landmarkCount: number;
  terminusCount: number;
  traderCount: number;
  recentTLCount: number;
  activeGroupingCount: number;
  onOpenGroupings: () => void;
  landmarkSearch: string;
  landmarkSuggestions: string[];
  onLandmarkSearchChange: (next: string) => void;
  onLandmarkSelect: (name: string) => void;
  favoriteStartingPosition: { x: number; z: number; zoom?: number } | null;
  canSaveCurrentAsHome: boolean;
  onJumpHome: () => void;
  onSaveCurrentAsHome: () => void;
  onClearHome: () => void;
};

/**
 * Floating control surfaces rendered over the map while in fullscreen mode.
 * Kept to the minimum required interactions (exit, groupings, TL/landmark
 * toggles, recently-added filter, landmark search) so the map itself stays
 * the focus. The panel is `pointer-events-none` at the root and individual
 * controls re-enable pointer events, allowing the user to pan the map
 * through the gaps between panels.
 */
export function FullscreenControlsOverlay({
  translocatorCount,
  visibleTranslocatorCount,
  filteringActive,
  landmarkCount,
  terminusCount,
  traderCount,
  recentTLCount,
  activeGroupingCount,
  onOpenGroupings,
  landmarkSearch,
  landmarkSuggestions,
  onLandmarkSearchChange,
  onLandmarkSelect,
  favoriteStartingPosition,
  canSaveCurrentAsHome,
  onJumpHome,
  onSaveCurrentAsHome,
  onClearHome,
}: FullscreenControlsOverlayProps) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const showTranslocators = useAppSelector((s) => s.mapView.showTranslocators);
  const setShowTranslocators = useCallback(
    (next: boolean) => dispatch(setShowTranslocatorsAction(next)),
    [dispatch],
  );
  const showLandmarks = useAppSelector((s) => s.mapView.showLandmarks);
  const setShowLandmarks = useCallback(
    (next: boolean) => dispatch(setShowLandmarksAction(next)),
    [dispatch],
  );
  const showTerminus = useAppSelector((s) => s.mapView.showTerminus);
  const setShowTerminus = useCallback(
    (next: boolean) => dispatch(setShowTerminusAction(next)),
    [dispatch],
  );
  const showTraders = useAppSelector((s) => s.mapView.showTraders);
  const setShowTraders = useCallback(
    (next: boolean) => dispatch(setShowTradersAction(next)),
    [dispatch],
  );

  // Oceans overlay is a special case: it's very expensive to render, so we want to keep it off by default and let users explicitly opt in when they want to see it. Because of this, its visibility state is kept local and not synced to the Redux store (unlike the other overlays), so it won't affect users who don't care about oceans and won't be accidentally toggled on by users who do.
  // const [showOceans, setShowOceans] = useState(false);
  const showOceans = useAppSelector((s) => s.mapView.showOceans);
  const setShowOceans = useCallback(
    (next: boolean) => dispatch(setShowOceansAction(next)),
    [dispatch],
  );
  // Account-level gate: the Oceans toggle in fullscreen is only visible
  // when the user has opted into "Show additional options on Map" from
  // their account preferences. Default OFF.
  const showAdvancedMapOptions = useAppSelector((s) => s.mapView.showAdvancedMapOptions);
  const traderTypeFilter = useAppSelector((s) => s.mapView.traderTypeFilter);
  const traderTypeFilterSet = useMemo(() => new Set<string>(traderTypeFilter), [traderTypeFilter]);
  const toggleTraderType = useCallback(
    (t: TraderType) => dispatch(toggleTraderTypeFilterAction(t)),
    [dispatch],
  );
  // Fullscreen mode (local, not persisted): hides the page chrome and renders
  // the map at viewport size with floating control panels.
  // const [isFullscreen, setIsFullscreen] = useState(false);
  const isFullscreen = useReduxState("mapView.isFullscreen");
  const setIsFullscreen = useCallback(
    (next: boolean) => dispatch(setShowFullscreenAction(next)),
    [dispatch],
  );
  // "Emphasize recently added TLs" augments the favourites filter. When ON, the
  // visible TL set is the union of (active grouping members) and TLs whose
  // `meta.addedAt` falls inside RECENT_TL_WINDOW_MS — so a user can keep
  // their favourite groupings *and* still see freshly contributed segments
  // from the community.
  const showRecentlyAddedTLsRaw = useAppSelector((s) => s.mapView.showRecentlyAdded);
  // WC geojson exports lack `addedAt` timestamps so the recently-added
  // augmentation has no signal there. Mirror the gate in TOPSMapViewPage
  // so the FS overlay matches: hide the toggle and force the effect off
  // without clobbering the persisted preference.
  const usingWebCartographer = useAppSelector((s) => s.mapView.mapSource) === "webcartographer";
  const showRecentlyAddedTLs = showRecentlyAddedTLsRaw; //&& !usingWebCartographer;
  const toggleShowRecentlyAddedTLs = useCallback(
    (next?: boolean) => dispatch(toggleShowRecentlyAddedAction(next)),
    [dispatch],
  );
  // Route planner state — the open button mirrors the non-fullscreen one
  // so users can summon the planner sheet without leaving fullscreen.
  const routePlannerOpen = useAppSelector((s) => s.routePlanner.isOpen);
  // Active-route signals so the fullscreen Route button can advertise an
  // active route the same way the non-fullscreen toolbar button does.
  const routes = useAppSelector((s) => s.routePlanner.routes);
  const routeSelectedIndex = useAppSelector((s) => s.routePlanner.selectedIndex);
  const routeFrom = useAppSelector((s) => s.routePlanner.from);
  const routeTo = useAppSelector((s) => s.routePlanner.to);
  const activeRoute = routes.length > 0 ? (routes[routeSelectedIndex] ?? routes[0]) : null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {/* Top-left: exit fullscreen. */}
      <div className="pointer-events-auto absolute top-16 left-6  flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setIsFullscreen(false)}
          title={t("topsMap.exitFullscreen")}
          className="shadow-md"
        >
          <Minimize2 className="size-4 mr-1" />
          {t("topsMap.exitFullscreen")}
        </Button>
        <HomePositionControls
          favorite={favoriteStartingPosition}
          canSaveCurrent={canSaveCurrentAsHome}
          onJumpHome={onJumpHome}
          onSaveCurrent={onSaveCurrentAsHome}
          onClear={onClearHome}
          compact
        />
      </div>

      {/* Top-right: stacked toggles + groupings. */}
      <div className="pointer-events-auto absolute top-16 right-6 flex w-80 flex-col gap-2">
        <div
          onClick={() => setShowTranslocators(!showTranslocators)}
          className="cursor-pointer flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-md backdrop-blur"
        >
          <Switch checked={showTranslocators} aria-label={t("topsMap.showTranslocatorOverlay")} />
          <Label className="cursor-pointer">{t("topsMap.showTranslocators")}</Label>
          <span className="ml-auto text-xs text-muted-foreground select-none">
            {filteringActive
              ? `${visibleTranslocatorCount.toLocaleString()} / ${translocatorCount.toLocaleString()}`
              : translocatorCount.toLocaleString()}
          </span>
        </div>
        <div
          onClick={() => showTranslocators && toggleShowRecentlyAddedTLs(!showRecentlyAddedTLs)}
          className={cn(
            "flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-md backdrop-blur",
            {
              "opacity-50": !showTranslocators,
              "cursor-pointer": showTranslocators,
              // "hidden": usingWebCartographer,
            },
          )}
        >
          <Switch
            disabled={!showTranslocators}
            checked={showRecentlyAddedTLs}
            aria-label={t("topsMap.emphasizeRecentlyAddedTranslocators")}
          />
          <Label
            className={cn(" text-xs leading-tight", {
              "cursor-pointer": showTranslocators,
            })}
          >
            {t("topsMap.recentlyAddedTitle")}
            <span className="block text-[10px] text-muted-foreground">
              {t("topsMap.recentlyAddedSubtitle", { days: 14 })}
            </span>
          </Label>
          <span className="ml-auto text-xs text-muted-foreground select-none">
            {recentTLCount.toLocaleString()}
          </span>
        </div>
        <div
          onClick={() => setShowLandmarks(!showLandmarks)}
          className="cursor-pointer flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-md backdrop-blur"
        >
          <Switch checked={showLandmarks} aria-label={t("topsMap.showLandmarksOverlay")} />
          <Label className="cursor-pointer">{t("topsMap.showLandmarks")}</Label>
          <span className="ml-auto text-xs text-muted-foreground select-none">
            {landmarkCount.toLocaleString()}
          </span>
        </div>
        <div
          onClick={() => setShowTerminus(!showTerminus)}
          className="cursor-pointer flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-md backdrop-blur"
        >
          <Switch checked={showTerminus} aria-label={t("topsMap.showTerminusTeleportersOverlay")} />
          <Label className="cursor-pointer">{t("topsMap.showTerminusTeleporters")}</Label>
          <span className="ml-auto text-xs text-muted-foreground select-none">
            {terminusCount.toLocaleString()}
          </span>
        </div>
        <div className="flex flex-col rounded-md border bg-background/95 px-3 py-2 text-sm shadow-md backdrop-blur">
          <div
            onClick={() => setShowTraders(!showTraders)}
            className="cursor-pointer flex items-center gap-2"
          >
            <Switch checked={showTraders} aria-label={t("topsMap.showTradersOverlay")} />
            <Label className="cursor-pointer">{t("topsMap.showTraders")}</Label>
            <span className="ml-auto text-xs text-muted-foreground select-none">
              {traderCount.toLocaleString()}
            </span>
          </div>
          <div
            className="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
            style={{
              gridTemplateRows: showTraders && traderCount > 0 ? "1fr" : "0fr",
            }}
            aria-hidden={!(showTraders && traderCount > 0)}
          >
            <div className="overflow-hidden min-h-0">
              <div className="flex flex-wrap gap-1 pt-2">
                {TRADER_TYPES.map((t, i) => {
                  const active = traderTypeFilterSet.has(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleTraderType(t);
                      }}
                      tabIndex={showTraders && traderCount > 0 ? 0 : -1}
                      className={cn(
                        "select-none rounded-full border px-2 py-0.5 text-xs cursor-pointer",
                        showTraders &&
                          traderCount > 0 &&
                          "animate-in fade-in-0 slide-in-from-top-1 fill-mode-both",
                        "transition-colors duration-150",
                        active ? "bg-foreground text-background" : "bg-background",
                      )}
                      style={{
                        borderColor: TRADER_TYPE_COLORS[t],
                        animationDelay: `${i * 35}ms`,
                        animationDuration: "260ms",
                      }}
                      aria-pressed={active}
                      title={TRADER_TYPE_LABELS[t]}
                    >
                      <span
                        aria-hidden
                        className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                        style={{ backgroundColor: TRADER_TYPE_COLORS[t] }}
                      />
                      {TRADER_TYPE_LABELS[t]}
                    </button>
                  );
                })}
                {traderTypeFilterSet.size > 0 && (
                  <span
                    className={cn(
                      "text-[10px] text-muted-foreground ml-1 self-center",
                      showTraders && traderCount > 0 && "animate-in fade-in-0 fill-mode-both",
                    )}
                    style={{
                      animationDelay: `${TRADER_TYPES.length * 35}ms`,
                      animationDuration: "260ms",
                    }}
                  >
                    {t("topsMap.showingTypes", {
                      shown: traderTypeFilterSet.size,
                      total: TRADER_TYPES.length,
                    })}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
        <div
          onClick={() => setShowOceans(!showOceans)}
          className={cn(
            "cursor-pointer flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-md backdrop-blur",
            !showAdvancedMapOptions && "hidden",
          )}
        >
          <Switch checked={showOceans} aria-label={t("topsMap.showOceansOverlay")} />
          <Label className="cursor-pointer">{t("topsMap.oceans")}</Label>
          <span className="text-xs text-muted-foreground">
            {t("topsMap.totalCount", { count: OCEANS_TOTAL_COUNT.toLocaleString() })}
          </span>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onOpenGroupings}
          className="shadow-md"
        >
          <Layers className="size-4 mr-1" />
          {t("topsMap.groupings")}
          {activeGroupingCount > 0 && (
            <span className="ml-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground select-none">
              {activeGroupingCount}
            </span>
          )}
        </Button>
        <Button
          type="button"
          variant={activeRoute || routePlannerOpen ? "default" : "secondary"}
          size="sm"
          onClick={() => dispatch(setRoutePlannerOpen(!routePlannerOpen))}
          className={cn(
            "shadow-md",
            activeRoute &&
              "bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-emerald-500 dark:bg-emerald-600 dark:hover:bg-emerald-700",
          )}
          aria-label={
            activeRoute
              ? t("routePlanner.routeActiveAria", {
                  duration: formatDuration(activeRoute.totalSeconds),
                  action: routePlannerOpen
                    ? t("routePlanner.routePlannerHide")
                    : t("routePlanner.routePlannerShow"),
                })
              : routePlannerOpen
                ? t("routePlanner.routePlannerHide")
                : t("routePlanner.routePlannerShow")
          }
          title={
            activeRoute
              ? t("routePlanner.routeActiveTitle", {
                  duration: formatDuration(activeRoute.totalSeconds),
                  count: t("routePlanner.tlHops", { count: activeRoute.tlHops }),
                })
              : undefined
          }
        >
          <Waypoints className="size-4 mr-1" />
          {t("routePlanner.routeButton")}
          {activeRoute ? (
            <span className="ml-1.5 rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none">
              {formatDuration(activeRoute.totalSeconds)}
            </span>
          ) : routeFrom || routeTo ? (
            <span
              className="ml-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500"
              aria-hidden="true"
            />
          ) : null}
        </Button>
      </div>

      {/* Bottom-left: landmark search. */}
      <div className="pointer-events-auto absolute bottom-6 left-6 w-72 rounded-md border bg-background/95 p-2 shadow-md backdrop-blur">
        <Label
          htmlFor="landmark-search-fullscreen"
          className="mb-1 flex items-center gap-1 text-xs text-muted-foreground"
        >
          <Search className="size-3" />
          {t("topsMap.searchLandmark")}
        </Label>
        <Combobox
          id="landmark-search-fullscreen"
          placeholder={t("topsMap.typeToSearch")}
          value={landmarkSearch}
          suggestions={landmarkSuggestions}
          onChange={onLandmarkSearchChange}
          onSelect={onLandmarkSelect}
          dropUp
        />
      </div>
    </div>
  );
}

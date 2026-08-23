import { memo } from "react";
import { Layers, Waypoints } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CollapsibleSection } from "@/components/tops-map/CollapsibleSection";
import { GroupEditingInfo } from "@/components/tops-map-viewer/GroupEditingInfo";
import { TRADER_TYPES, TRADER_TYPE_LABELS, type TraderType } from "@/lib/trader-types";
import { formatDuration } from "@/lib/format-duration";
import type { RouteResult } from "@/lib/tl-routing";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface LayersSectionProps {
  showTranslocators: boolean;
  setShowTranslocators: (next: boolean) => void;
  filteringActive: boolean;
  visibleTranslocatorCount: number;
  translocatorCount: number;
  activeGroupingCount: number;
  onOpenGroupings: () => void;
  routes: RouteResult[];
  routePlannerOpen: boolean;
  routeSelectedIndex: number;
  routeFrom: unknown;
  routeTo: unknown;
  onToggleRoutePlanner: () => void;
  showRecentlyAddedTLs: boolean;
  toggleShowRecentlyAddedTLs: () => void;
  recentTLCount: number;
  editingGrouping: React.ComponentProps<typeof GroupEditingInfo>["editingGrouping"];
  setEditingGroupingId: React.ComponentProps<typeof GroupEditingInfo>["setEditingGroupingId"];
  showLandmarks: boolean;
  setShowLandmarks: (next: boolean) => void;
  landmarkCount: number;
  showTerminus: boolean;
  setShowTerminus: (next: boolean) => void;
  terminusCount: number;
  tradersLoaded: boolean;
  showTraders: boolean;
  setShowTraders: (next: boolean) => void;
  traderCount: number;
  traderColors: Record<TraderType, string>;
  traderTypeFilterSet: Set<string>;
  toggleTraderType: (t: TraderType) => void;
}

/** Standard overlay toggles: translocators (+ groupings / route planner
 *  buttons), recently-added, landmarks, terminus, and the traders card. */
export const LayersSection = memo(function LayersSection({
  showTranslocators,
  setShowTranslocators,
  filteringActive,
  visibleTranslocatorCount,
  translocatorCount,
  activeGroupingCount,
  onOpenGroupings,
  routes,
  routePlannerOpen,
  routeSelectedIndex,
  routeFrom,
  routeTo,
  onToggleRoutePlanner,
  showRecentlyAddedTLs,
  toggleShowRecentlyAddedTLs,
  recentTLCount,
  editingGrouping,
  setEditingGroupingId,
  showLandmarks,
  setShowLandmarks,
  landmarkCount,
  showTerminus,
  setShowTerminus,
  terminusCount,
  tradersLoaded,
  showTraders,
  setShowTraders,
  traderCount,
  traderColors,
  traderTypeFilterSet,
  toggleTraderType,
}: LayersSectionProps) {
  const { t } = useTranslation();
  return (
    <CollapsibleSection
      title={t("topsMap.layerGroups.layers")}
      icon={<Layers className="size-4 text-muted-foreground" />}
      defaultOpen
    >
      <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <Switch
          checked={showTranslocators}
          onCheckedChange={setShowTranslocators}
          aria-label={t("topsMap.showTranslocatorOverlay")}
        />
        <Label>{t("topsMap.showTranslocators")}</Label>
        <span className="text-xs text-muted-foreground ml-2">
          {t("topsMap.translocatorsFound")}{" "}
          <span className="font-medium text-foreground">
            {filteringActive
              ? t("topsMap.translocatorsShown", {
                  visible: visibleTranslocatorCount.toLocaleString(),
                  total: translocatorCount.toLocaleString(),
                })
              : translocatorCount.toLocaleString()}
          </span>
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={onOpenGroupings}
        >
          <Layers className="size-4 mr-1" />
          {t("topsMap.groupings")}
          {activeGroupingCount > 0 && (
            <span className="ml-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
              {activeGroupingCount}
            </span>
          )}
        </Button>
        <Button
          type="button"
          variant={
            // Active route wins over "panel-open" so the button
            // visually advertises the route even after the user
            // collapses the planner. Fall back to the original
            // open/closed states otherwise.
            routes.length > 0 ? "default" : routePlannerOpen ? "default" : "outline"
          }
          size="sm"
          onClick={onToggleRoutePlanner}
          className={
            routes.length > 0
              ? "bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-emerald-500 dark:bg-emerald-600 dark:hover:bg-emerald-700"
              : undefined
          }
          aria-label={
            routes.length > 0
              ? t("routePlanner.routeActiveAria", {
                  duration: formatDuration((routes[routeSelectedIndex] ?? routes[0]).totalSeconds),
                  action: routePlannerOpen
                    ? t("routePlanner.routePlannerHide")
                    : t("routePlanner.routePlannerShow"),
                })
              : routePlannerOpen
                ? t("routePlanner.routePlannerHide")
                : t("routePlanner.routePlannerShow")
          }
          title={
            routes.length > 0
              ? t("routePlanner.routeActiveTitle", {
                  duration: formatDuration((routes[routeSelectedIndex] ?? routes[0]).totalSeconds),
                  count: t("routePlanner.tlHops", {
                    count: (routes[routeSelectedIndex] ?? routes[0]).tlHops,
                  }),
                })
              : undefined
          }
        >
          <Waypoints className="size-4 mr-1" />
          {t("routePlanner.routeButton")}
          {routes.length > 0 ? (
            // Inline ETA pill — visible whether the planner is open
            // or collapsed, so the user always knows a route is
            // currently being displayed on the map and roughly how
            // long it takes.
            <span className="ml-1.5 rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none">
              {formatDuration((routes[routeSelectedIndex] ?? routes[0]).totalSeconds)}
            </span>
          ) : routeFrom || routeTo ? (
            // Endpoints picked but no route yet — a small pulsing
            // dot signals "planning in progress" without competing
            // with the loaded-route ETA pill above.
            <span
              className="ml-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500"
              aria-hidden="true"
            />
          ) : null}
        </Button>
      </div>
      {/* {!usingWebCartographer && ( */}
      <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <Switch
          checked={showRecentlyAddedTLs}
          onCheckedChange={toggleShowRecentlyAddedTLs}
          aria-label={t("topsMap.emphasizeRecentlyAddedTranslocators")}
        />
        <Label>{t("topsMap.emphasizeRecentlyAddedTls", { days: 14 })}</Label>
        <span className="text-xs text-muted-foreground ml-2">
          {t("topsMap.recentCount", { count: recentTLCount.toLocaleString() })}
        </span>
      </div>
      {/* )} */}
      <GroupEditingInfo
        editingGrouping={editingGrouping}
        setEditingGroupingId={setEditingGroupingId}
      />
      <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <Switch
          checked={showLandmarks}
          onCheckedChange={setShowLandmarks}
          aria-label={t("topsMap.showLandmarksOverlay")}
        />
        <Label>{t("topsMap.showLandmarks")}</Label>
        <span className="text-xs text-muted-foreground ml-2">
          {t("topsMap.landmarksFound")}{" "}
          <span className="font-medium text-foreground">{landmarkCount.toLocaleString()}</span>
        </span>
      </div>
      <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <Switch
          checked={showTerminus}
          onCheckedChange={setShowTerminus}
          aria-label={t("topsMap.showTerminusTeleportersOverlay")}
        />
        <Label>{t("topsMap.showTerminusTeleporters")}</Label>
        <span className="text-xs text-muted-foreground ml-2">
          {t("topsMap.terminusMapped")}{" "}
          <span className="font-medium text-foreground">{terminusCount.toLocaleString()}</span>
        </span>
      </div>
      {tradersLoaded && (
        <div className={cn("flex flex-col rounded-md border px-3 py-2 text-sm")}>
          <div className="flex items-center gap-2">
            <Switch
              checked={showTraders}
              onCheckedChange={setShowTraders}
              aria-label={t("topsMap.showTradersOverlay")}
            />
            <Label>{t("topsMap.showTraders")}</Label>
            <span className="text-xs text-muted-foreground ml-2">
              {t("topsMap.tradersMapped")}{" "}
              <span className="font-medium text-foreground">{traderCount.toLocaleString()}</span>
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
              <div className="flex flex-wrap gap-1 pt-3">
                {TRADER_TYPES.map((t, i) => {
                  const active = traderTypeFilterSet.has(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleTraderType(t)}
                      tabIndex={showTraders && traderCount > 0 ? 0 : -1}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-xs cursor-pointer",
                        showTraders &&
                          traderCount > 0 &&
                          "animate-in fade-in-0 slide-in-from-top-1 fill-mode-both",
                        "transition-colors duration-150",
                        active ? "bg-foreground text-background" : "bg-background",
                      )}
                      style={{
                        borderColor: traderColors[t],
                        animationDelay: `${i * 35}ms`,
                        animationDuration: "260ms",
                      }}
                      aria-pressed={active}
                    >
                      <span
                        aria-hidden
                        className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                        style={{ backgroundColor: traderColors[t] }}
                      />
                      {TRADER_TYPE_LABELS[t]}
                    </button>
                  );
                })}
                {traderTypeFilterSet.size > 0 && (
                  <span
                    className={cn(
                      "text-xs text-muted-foreground ml-1 self-center",
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
      )}
    </CollapsibleSection>
  );
});

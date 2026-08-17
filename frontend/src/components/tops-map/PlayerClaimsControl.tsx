import { useCallback, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Slider } from "../ui/slider";
import { Combobox } from "../ui/combobox";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  setShowPlayerClaims as setShowPlayerClaimsAction,
  setPlayerClaimsMode as setPlayerClaimsModeAction,
  setPlayerClaimsSearch as setPlayerClaimsSearchAction,
  setPlayerClaimsOpacity as setPlayerClaimsOpacityAction,
} from "@/store/slices/mapView";
import { usePlayerClaims } from "@/hooks/usePlayerClaims";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface PlayerClaimsControlProps {
  /**
   * `"card"` renders the opaque bordered card used in the normal controls
   * column; `"fullscreen"` renders the translucent floating panel used by the
   * fullscreen overlay stack.
   */
  variant?: "card" | "fullscreen";
}

/**
 * Toggle + density/search/all mode controls for the player land-claim overlay.
 * Self-contained (reads/writes the shared `mapView` slice and loads the claim
 * boxes via React Query for the count / owner suggestions), so it can be shared
 * between {@link TOPSMapViewPage}'s controls column and the fullscreen
 * {@link FullscreenControlsOverlay} without duplicating the panel markup.
 */
export function PlayerClaimsControl({ variant = "card" }: PlayerClaimsControlProps) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const fullscreen = variant === "fullscreen";

  const showAdvancedMapOptions = useAppSelector((s) => s.mapView.showAdvancedMapOptions);
  const showPlayerClaims = useAppSelector((s) => s.mapView.showPlayerClaims);
  const playerClaimsMode = useAppSelector((s) => s.mapView.playerClaimsMode);
  const playerClaimsSearch = useAppSelector((s) => s.mapView.playerClaimsSearch);
  const playerClaimsOpacity = useAppSelector((s) => s.mapView.playerClaimsOpacity);

  const setShowPlayerClaims = useCallback(
    (next: boolean) => dispatch(setShowPlayerClaimsAction(next)),
    [dispatch],
  );
  const setPlayerClaimsMode = useCallback(
    (next: "density" | "search" | "all") => dispatch(setPlayerClaimsModeAction(next)),
    [dispatch],
  );
  const setPlayerClaimsSearch = useCallback(
    (next: string) => dispatch(setPlayerClaimsSearchAction(next)),
    [dispatch],
  );
  const setPlayerClaimsOpacity = useCallback(
    (next: number) => dispatch(setPlayerClaimsOpacityAction(next)),
    [dispatch],
  );

  // Shares the page loader's query key — surfaces owners + count without an
  // extra fetch.
  const playerClaimsQuery = usePlayerClaims(showAdvancedMapOptions && showPlayerClaims);
  const playerClaimOwners = useMemo(() => {
    const set = new Set<string>();
    for (const c of playerClaimsQuery.data ?? []) if (c.owner) set.add(c.owner);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [playerClaimsQuery.data]);
  const playerClaimMatchCount = useMemo(() => {
    const q = playerClaimsSearch.trim().toLowerCase();
    if (!q) return 0;
    let n = 0;
    for (const c of playerClaimsQuery.data ?? []) {
      if (c.owner.toLowerCase().includes(q)) n++;
    }
    return n;
  }, [playerClaimsQuery.data, playerClaimsSearch]);

  // Keep the panel's overflow clipped while it animates open/shut; only reveal
  // it once fully expanded so the search dropdown can escape the card.
  const [playerClaimsPanelExpanded, setPlayerClaimsPanelExpanded] = useState(false);
  useEffect(() => {
    if (!showPlayerClaims) setPlayerClaimsPanelExpanded(false);
  }, [showPlayerClaims]);

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border px-3 py-2 text-sm",
        fullscreen && "bg-background/95 shadow-md backdrop-blur",
      )}
    >
      <div
        onClick={() => setShowPlayerClaims(!showPlayerClaims)}
        className="cursor-pointer flex items-center gap-2"
      >
        <Switch checked={showPlayerClaims} aria-label={t("topsMap.showPlayerClaimsOverlay")} />
        <Label className="cursor-pointer">{t("topsMap.showPlayerClaims")}</Label>
        <span className="text-xs text-muted-foreground">
          {t("topsMap.totalCount", {
            count: (playerClaimsQuery.data?.length ?? 0).toLocaleString(),
          })}
        </span>
      </div>
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: showPlayerClaims ? "1fr" : "0fr" }}
        aria-hidden={!showPlayerClaims}
        onTransitionEnd={() => {
          if (showPlayerClaims) setPlayerClaimsPanelExpanded(true);
        }}
      >
        <div
          className={cn("min-h-0", playerClaimsPanelExpanded ? "overflow-visible" : "overflow-hidden")}
        >
          <div className="flex flex-col gap-2 pt-1">
            <div className="flex rounded-md border p-0.5">
              <button
                type="button"
                onClick={() => setPlayerClaimsMode("density")}
                className={cn(
                  "flex-1 rounded px-2 py-1 text-xs transition-colors",
                  playerClaimsMode === "density"
                    ? "bg-foreground text-background"
                    : "hover:bg-muted",
                )}
              >
                {t("topsMap.playerClaimsDensityMode")}
              </button>
              <button
                type="button"
                onClick={() => setPlayerClaimsMode("search")}
                className={cn(
                  "flex-1 rounded px-2 py-1 text-xs transition-colors",
                  playerClaimsMode === "search"
                    ? "bg-foreground text-background"
                    : "hover:bg-muted",
                )}
              >
                {t("topsMap.playerClaimsSearchMode")}
              </button>
              <button
                type="button"
                onClick={() => setPlayerClaimsMode("all")}
                className={cn(
                  "flex-1 rounded px-2 py-1 text-xs transition-colors",
                  playerClaimsMode === "all"
                    ? "bg-foreground text-background"
                    : "hover:bg-muted",
                )}
              >
                {t("topsMap.playerClaimsAllMode")}
              </button>
            </div>
            {playerClaimsMode === "density" ? (
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">
                  {t("topsMap.playerClaimsOpacity")}
                </Label>
                <Slider
                  className="flex-1 px-2"
                  min={0}
                  max={1}
                  step={0.05}
                  value={playerClaimsOpacity}
                  onValueChange={(v) => setPlayerClaimsOpacity(v)}
                  aria-label={t("topsMap.playerClaimsOpacity")}
                />
              </div>
            ) : playerClaimsMode === "all" ? (
              <span className="text-xs text-muted-foreground">
                {t("topsMap.playerClaimsAllHint")}
              </span>
            ) : (
              <div className="flex flex-col gap-1">
                <Label
                  htmlFor="player-claim-search"
                  className="flex items-center gap-1 text-xs text-muted-foreground"
                >
                  <Search className="size-3" />
                  {t("topsMap.playerClaimsSearchPlaceholder")}
                </Label>
                <Combobox
                  id="player-claim-search"
                  placeholder={t("topsMap.typeToSearch")}
                  value={playerClaimsSearch}
                  suggestions={playerClaimOwners}
                  onChange={setPlayerClaimsSearch}
                  onSelect={setPlayerClaimsSearch}
                  dropUp={fullscreen}
                />
                {playerClaimsSearch.trim() ? (
                  <span className="text-xs text-muted-foreground">
                    {t("topsMap.playerClaimsMatchCount", {
                      count: playerClaimMatchCount.toLocaleString(),
                    })}
                  </span>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

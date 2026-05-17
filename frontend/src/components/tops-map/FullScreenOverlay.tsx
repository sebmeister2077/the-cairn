import { Layers, Minimize2, Search } from "lucide-react";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Combobox } from "../ui/combobox";
import { useAppDispatch, useAppSelector, useReduxState } from "@/store/hooks";
import { useCallback } from "react";
import {
  setSelectedLevel as setSelectedLevelAction,
  setGroupingsViewMode as setGroupingsViewModeAction,
  setActiveGroupingIds as setActiveGroupingIdsAction,
  toggleActiveGrouping as toggleActiveGroupingAction,
  setShowLandmarks as setShowLandmarksAction,
  setShowTranslocators as setShowTranslocatorsAction,
  setShowFullscreen as setShowFullscreenAction,
  toggleShowRecentlyAdded as toggleShowRecentlyAddedAction,
} from "@/store/slices/mapView";

type FullscreenControlsOverlayProps = {
  translocatorCount: number;
  visibleTranslocatorCount: number;
  filteringActive: boolean;
  landmarkCount: number;
  recentTLCount: number;
  activeGroupingCount: number;
  onOpenGroupings: () => void;
  landmarkSearch: string;
  landmarkSuggestions: string[];
  onLandmarkSearchChange: (next: string) => void;
  onLandmarkSelect: (name: string) => void;
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
  recentTLCount,
  activeGroupingCount,
  onOpenGroupings,
  landmarkSearch,
  landmarkSuggestions,
  onLandmarkSearchChange,
  onLandmarkSelect,
}: FullscreenControlsOverlayProps) {
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
  // Fullscreen mode (local, not persisted): hides the page chrome and renders
  // the map at viewport size with floating control panels.
  // const [isFullscreen, setIsFullscreen] = useState(false);
  const isFullscreen = useReduxState("mapView.isFullscreen");
  const setIsFullscreen = useCallback(
    (next: boolean) => dispatch(setShowFullscreenAction(next)),
    [dispatch],
  );
  // "Include recently added TLs" augments the favourites filter. When ON, the
  // visible TL set is the union of (active grouping members) and TLs whose
  // `meta.addedAt` falls inside RECENT_TL_WINDOW_MS — so a user can keep
  // their favourite groupings *and* still see freshly contributed segments
  // from the community.
  const showRecentlyAddedTLs = useAppSelector((s) => s.mapView.showRecentlyAdded);
  const toggleShowRecentlyAddedTLs = useCallback(
    () => dispatch(toggleShowRecentlyAddedAction()),
    [dispatch],
  );
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {/* Top-left: exit fullscreen. */}
      <div className="pointer-events-auto absolute top-16 left-6">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setIsFullscreen(false)}
          title="Exit fullscreen"
          className="shadow-md"
        >
          <Minimize2 className="size-4 mr-1" />
          Exit fullscreen
        </Button>
      </div>

      {/* Top-right: stacked toggles + groupings. */}
      <div className="pointer-events-auto absolute top-16 right-6 flex w-72 flex-col gap-2">
        <div
          onClick={() => setShowTranslocators(!showTranslocators)}
          className="cursor-pointer flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-md backdrop-blur"
        >
          <Switch checked={showTranslocators} aria-label="Show translocator overlay" />
          <Label className="cursor-pointer">Translocators</Label>
          <span className="ml-auto text-xs text-muted-foreground">
            {filteringActive
              ? `${visibleTranslocatorCount.toLocaleString()} / ${translocatorCount.toLocaleString()}`
              : translocatorCount.toLocaleString()}
          </span>
        </div>
        <div
          onClick={() => setShowLandmarks(!showLandmarks)}
          className="cursor-pointer flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-md backdrop-blur"
        >
          <Switch checked={showLandmarks} aria-label="Show landmarks overlay" />
          <Label className="cursor-pointer">Landmarks</Label>
          <span className="ml-auto text-xs text-muted-foreground">
            {landmarkCount.toLocaleString()}
          </span>
        </div>
        <div
          onClick={() => toggleShowRecentlyAddedTLs()}
          className="cursor-pointer flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-md backdrop-blur"
        >
          <Switch
            checked={showRecentlyAddedTLs}
            aria-label="Include recently added translocators"
          />
          <Label className="cursor-pointer text-xs leading-tight">
            Recently added TLs
            <span className="block text-[10px] text-muted-foreground">last 14 days</span>
          </Label>
          <span className="ml-auto text-xs text-muted-foreground">
            {recentTLCount.toLocaleString()}
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
          Groupings
          {activeGroupingCount > 0 && (
            <span className="ml-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
              {activeGroupingCount}
            </span>
          )}
        </Button>
      </div>

      {/* Bottom-left: landmark search. */}
      <div className="pointer-events-auto absolute bottom-6 left-6 w-72 rounded-md border bg-background/95 p-2 shadow-md backdrop-blur">
        <Label
          htmlFor="landmark-search-fullscreen"
          className="mb-1 flex items-center gap-1 text-xs text-muted-foreground"
        >
          <Search className="size-3" />
          Search landmark
        </Label>
        <Combobox
          id="landmark-search-fullscreen"
          placeholder="Type to search…"
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

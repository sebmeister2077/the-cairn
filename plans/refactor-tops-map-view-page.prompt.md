# Prompt: refactor `TOPSMapViewPage.tsx`

## Goal

Reduce `frontend/src/pages/multiplayer/TOPSMapViewPage.tsx` (currently ~2,840 lines) to a thin orchestrator by **extracting cohesive logic and JSX into new hooks and components**. This is a **pure refactor**: **no behavior changes, no visual changes, no prop-shape changes to existing extracted components, no changes to Redux slice APIs**. The page must render and behave identically before and after.

## Ground rules (read carefully)

1. **Do not modify** any of these files unless strictly required to import a newly extracted symbol:
   - `frontend/src/store/slices/mapView.ts`
   - `frontend/src/store/slices/routePlanner.ts`
   - `frontend/src/store/slices/topsMapPreview.ts`
   - `frontend/src/store/slices/elkWalkable.ts`
   - `frontend/src/components/MapViewer.tsx`
   - `frontend/src/components/tops-map/WebCartographerMapViewer.tsx`
   - Anything under `frontend/src/hooks/` that already exists (you may **add** new hook files; do not modify existing ones).
   - Any translation JSON (`t("...")` keys must stay identical).
2. **Do not** add new libraries. Use what the file already imports.
3. **Do not** "improve" logic while moving it. If a `useMemo` has a redundant dep or a subtle bug, leave it. Copy verbatim.
4. **Do not** add docstrings, README updates, or comments beyond what already exists. Preserve the existing comments in the moved code.
5. **Do not** change the exported name or default-export shape of `TOPSMapViewPage`. It stays a named export from the same file path.
6. Keep the URL query-param behavior, `initialUrlParamsRef` one-shot semantics, ref identity (e.g., `favoriteInitialViewRef`, `lastViewportRef`, `viewportBoundsRef`), effect ordering, and Strict-Mode-idempotent guards **identical**.
7. Keep every `useCallback`/`useMemo` dependency array identical to the current version after extraction. If a dep list references a value that now lives in a hook return, the extracted hook must expose it so the page's dep list is unchanged.
8. **Validate after each extraction step**: run `pnpm --filter frontend tsc --noEmit` (or the workspace's equivalent — check `frontend/package.json` scripts) and `pnpm --filter frontend lint` for the touched files. Fix any resulting type/lint errors before moving on. Do not disable ESLint rules to paper over errors.
9. If any extraction turns out to change behavior (e.g., a captured stale closure, a different effect firing order), **revert that step** and either redesign it or skip it. Note skipped items in your final summary.
10. **Do not** touch unrelated files, run codemods across the repo, reformat imports, or "clean up" other components.

## Non-negotiable behavioral invariants

- The set of network requests fired on mount, on tab switch (`mapSource` change), and on pan/zoom must be **identical** (same query keys, same `enabled` gating, same `staleTime`/`gcTime`, same `refetchOnMount`).
- URL param writes (`level`, `x`, `z`, `zoom`, `auction`, route-share keys) must fire at the same times, with the same values, using `replace: true`.
- The route-share one-shot rehydrate must remain gated by `shareHydratedRef` and read `window.location.search` (not the captured `searchParams`) exactly as today.
- The Ctrl/Cmd+G shortcut and Escape-cancels-pick-mode listeners must attach/detach with the same lifetimes.
- Fullscreen mode's DOM structure (Card wrapper classes, `absolute inset-0` placement, `FullscreenControlsOverlay` props) is unchanged.
- The final props passed to `<MapViewer>` and `<WebCartographerMapViewer>` must be **exactly** the same values, in the same conditions, with the same identity stability. In particular: `finalOverlaySegments`, `finalOverlayPoints`, `finalHighlightedSegments`, `finalRouteOverlay`, `radiusFilter`, `groupingSegmentColors`, and every `on*` handler.

## Suggested extraction plan (execute in this order, commit-sized chunks)

You may deviate if you find a better slice boundary, but each step must be independently type-checked and behavior-preserving. New files go under the paths shown; use the existing style (arrow-fn components, named exports, `@/`-prefixed imports).

### Phase 1 — pure helpers (no React)

Create `frontend/src/lib/tops-map-view/`:

- `level-info.ts` — move the module-scope constants and helpers currently at the top of the page:
  - `STALE_TIME`
  - `RECENT_TL_WINDOW_MS`
  - `levelInfoStaleTimeMs(info)`
  - `isLevelInfoExpired(info)`
  - `levelToTileSet(info)`
  - The `TopsMapStatsResponse` interface.
- `landmark-points.ts` — extract the huge `landmarkPoints` `useMemo` body as a **pure function** `buildLandmarkPoints(args)` that takes every input the current memo reads (landmarks, toggles, traders, recordedFeatures, traderClaims data, traderColors, filter set, viewport bounds, favoritePos, etc.) and returns `WorldPointMarker[]`. The page then wraps it in `useMemo` with the same dep list. This is the single biggest win — that memo is ~200 lines.
- `landmark-search.ts` — pure helpers `buildLandmarkSuggestions(landmarks)` and `findLandmarkByLabel(landmarks, name)` used by `landmarkSuggestions` and `handleLandmarkSelect`.
- `route-overlay.ts` — pure builder `buildRouteOverlay(args)` for the `routeOverlay` memo (both route and rendezvous branches). Takes routes, indices, mode, rendezvousResult, elk state, selfUserId, from/to. Returns `RouteOverlay | null`.
- `preview-focus.ts` — pure `computePreviewFocus(segments, focusEdgeKey)` returning `{ x, z, spanBlocks } | null` for the preview `useEffect` that dispatches `setRouteFocusRequest`.

Nothing in this phase mounts React. Verify with `tsc`.

### Phase 2 — small hooks

Create `frontend/src/hooks/tops-map-view/`:

- `useUrlViewportSync.ts` — encapsulates the `initialUrlParamsRef` snapshot logic and returns `{ initialUrlParams, updateUrlParams }`. Uses `useSearchParams` internally.
- `useRouteShareRehydrate.ts` — the one-shot `useEffect` that decodes `ROUTE_SHARE_PARAM_KEYS`, dispatches `hydrateRoutePlannerFromShare`, and strips the params. Owns `shareHydratedRef` internally.
- `useGoToDialog.ts` — owns `goToDialogOpen`, `goToXInput`, `goToZInput`, `goToError` state, the `handleOpenGoToDialog`, `handleGoToSubmit` callbacks, and the Ctrl/Cmd+G keyboard shortcut effect. Takes `{ lastViewportRef, favoriteStartingPosition, focusPoint setters, t }` and returns everything the JSX needs.
- `useHomeNavigation.ts` — `handleJumpHome` + `handleSetCurrentAsHome`. Takes `{ lastViewportRef, favoriteStartingPosition, setFavoriteStartingPosition, setLandmarkFocusPoint, setLandmarkFocusSpanBlocks }`.
- `useWcTileCacheVersioning.ts` — the `useEffect` that computes the `version` string and calls `notifyWCTileCacheVersion`. Inputs are the flags and last-modified strings.
- `useWcDownDialog.ts` — owns `wcDownOpen`, computes `wcUpstreamStatus` from the two WC queries, runs the snooze-read effect, and returns `{ wcDownOpen, setWcDownOpen, wcUpstreamStatus, handleSwitchToBackup, handleSnoozeWcDown }`. Reads `mapSource`, `webCartographerUrl`, and dispatches through hooks passed in (or use `useAppDispatch` inside).
- `useMapLevelData.ts` — wraps the `statsQuery` + `levelInfoQuery` + derived `completedLevels`, `tileSet`, `stats`, `selectedLevelGeneratedAt`, `loading`, `error`, `isReloading`, `hasMap`, and the `handleReload` callback. Also exposes `selectLevelForZoom` (the `enhanceTilesFn`). Enabled/disabled by `usingWebCartographer`. Returns a bag of exactly the values the page currently derives.
- `useAllLandmarks.ts` — the `allLandmarks` merge memo that combines backend + WC landmarks with the dedupe logic. Takes `{ usingWebCartographer, backendLandmarks, wcLandmarks }`.
- `useTranslocatorSelection.ts` — owns `selectedTranslocator`, `translocatorPinned`, and the click/right-click/unpin/turn-off effect. Takes `{ showTranslocators, editingGroupingId, groupingsStore }`.
- `useLandmarkFocus.ts` — owns `landmarkFocusPoint`, `landmarkFocusSpanBlocks`, `landmarkSearch`; effect that mirrors `routeFocusRequest`. Returns `handleLandmarkSelect` bound to a passed-in `landmarks` array.
- `useRoutePickMode.ts` — owns `handleRouteWorldClick` and the Escape listener effect.
- `useAuctionLayerFromUrl.ts` — the initial-state reader of `?auction=` plus the setter identity you need. (Or leave inline — it's only ~6 lines; skip if extraction adds more noise than it removes.)

Each hook file: named export, JSDoc comment 1 line max explaining what it owns, matching the existing hook style.

### Phase 3 — big derived-state hooks

- `useTranslocatorViewSets.ts` — computes `editingGrouping`, `activeTLIdSet`, `recentTLIdSet`, `visibleTranslocatorSegments`, `highlightedTranslocatorSegments`, `filteringActive`, `groupingSegmentColors`, `radiusFilter`. Inputs: `showTranslocators`, `groupingsStore`, `groupingsViewMode`, `activeGroupingIds`, `translocatorSegments`, `showRecentlyAddedTLs`, `showTLsInRadius`, `tlRadiusBlocks`, `editingGroupingId`. Returns a single memoized bag or discrete memos — the important part is that each returned identity matches the current memo's identity semantics.
- `useTraderClaimsData.ts` — thin wrapper that computes `claimsDataEnabled` and calls `useTraderClaims` + `useTraderClaimTypesOverlay`, returning `{ traderClaimsQuery, traderClaimTypesQuery }`.
- `useViewportCulling.ts` — owns `viewportBoundsRef`, `brokenTLViewportBounds`, the two seed effects for broken-TL and rapids, and the `rockStrataCenter` state + effect gating. Returns `{ viewportBoundsRef, brokenTLViewportBounds, rockStrataCenter, handleViewportChange }`. The `handleViewportChange` here also updates `lastViewportRef.current` and calls `reportResourcesViewportRef.current` (both refs are passed in) and writes URL params via a passed-in `updateUrlParams`.
- `usePlayerClaimsView.ts` — computes `playerClaimDensity`, `playerClaimMarkers`, `playerClaimLabelMode`. Inputs are the four `playerClaims*` selectors and the query.
- `useClimateHoverSample.ts` — the tiny `climateHoverCoords` state + `climateHoverSample` memo pair.
- `useRoutePlannerDerived.ts` — reads all `routePlanner` selectors, mounts `useTLRoute`, mounts `useElkWalkable`, reads elk selectors, reads `accountMeQuery` (or take `selfUserId` as an input if that hook already lives elsewhere), computes `elkPendingAttestKeys`/`elkPendingUnattestKeys` and `routeOverlay`. Returns everything the JSX + the final overlay merge needs.
- `useTopsPreviewOverlays.ts` — reads `topsMapPreview` selectors, computes `previewGroupingSegments`, runs the focus-request effect, and returns the preview-aware final overlays merge: `{ previewActive, finalOverlaySegments, finalOverlayPoints, finalHighlightedSegments, finalRouteOverlay }`. Takes the non-preview versions and the route overlay as inputs.

### Phase 4 — JSX component extractions

Create under `frontend/src/components/tops-map-viewer/` (this is where similar page-specific pieces already live — do not lump them under `tops-map/` which is for reusable overlay pieces):

- `TopsMapToolbar.tsx` — the entire "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-muted/30 p-2" block: loading chip, download/reload group, home + go-to group, WC-mode variant, retry button, resolution selector, admin group (Resources + Map Cache dialog). Takes an explicit props bag; **do not** thread individual Redux selectors into it — the parent reads them and passes them down. This preserves current re-render granularity.
- `LayersSection.tsx` — the outer `<CollapsibleSection title="layers">` and every switch inside it: translocators row (with Groupings and Route buttons + ETA pill), recently-added row, `GroupEditingInfo`, landmarks, terminus, and the traders card with the trader-type pill grid. Takes ~25 props but is a single cohesive chunk.
  - Consider a nested `TradersLayerCard.tsx` if `LayersSection` still feels too big after extraction.
- `AdvancedLayersSection.tsx` — the `showAdvancedMapOptions && <CollapsibleSection title="advanced">…` block including oceans, broken TLs, rapids, trader claims, `PlayerClaimsControl`, `AuctionHeatmapControl`, `RockStrataLegendPanel`, `ClimateControlsPanel`, `ClimateHoverReadout`.
- `AdminSelectedDepositBar.tsx` — the small "flex items-center gap-2 rounded-md border bg-primary/5" chip shown when `isAdmin && selectedDeposit`.
- `LandmarkSearchField.tsx` — the `<Combobox>` block gated by `hasMap`.
- `MapViewerContainer.tsx` — a component that internally picks `<WebCartographerMapViewer>` vs `<MapViewer>` based on `usingWebCartographer` and forwards the (identical) props. Two large adjacent JSX blocks collapse into one call site. **Critical**: keep both call sites' prop lists exactly identical to today; do not deduplicate props that differ subtly between branches without verifying identity.
  - If merging risks changing conditional prop identity (e.g., WC gets `onHoverCoords` but MapViewer doesn't; MapViewer gets `enhanceTilesFn` and `onTileSetEnhanced` but WC doesn't), keep them as **two separate small wrapper components** (`CairnMapViewer.tsx`, `WcMapViewerHost.tsx`) rather than one merged one. Correctness > line count.
- `MapOverlayLayers.tsx` — the JSX inside the MapViewer's `overlay={ … }` prop (oceans, rock strata, resources, auction sell/buy). Rendered by the Cairn path.
- `WcOverlayLayers.tsx` — the JSX inside WC's `overlayRender` and `overlayRenderAbove` render props. Two named exports: `renderWcOverlayBelow` and `renderWcOverlayAbove` (or a component with a `slot: "below" | "above"` prop) — pick whichever keeps the render-prop call sites cleanest.

### Phase 5 — final page shape

After Phases 1–4 the page should be roughly:

```tsx
export function TOPSMapViewPage() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();

  // ~20 top-level useAppSelectors (persisted UI toggles). Leave these here
  // — pulling them into a hook doesn't buy anything and hurts readability.

  const { initialUrlParams, updateUrlParams } = useUrlViewportSync();
  useRouteShareRehydrate();
  const level = useMapLevelData({ usingWebCartographer });
  const allLandmarks = useAllLandmarks({ … });
  const { viewportBoundsRef, brokenTLViewportBounds, rockStrataCenter, handleViewportChange } =
    useViewportCulling({ … });
  // …every other Phase 2/3 hook…

  const landmarkPoints = useMemo(
    () => buildLandmarkPoints({ … }),
    [ /* identical dep list to today */ ],
  );

  // Toolbar, sections, viewer, dialogs, overlays.
  return (
    <Card …>
      {!isFullscreen && (
        <>
          <CardHeader>…</CardHeader>
          <MapSourceSelector />
          <TopsMapToolbar {…toolbarProps} />
          <LayersSection {…layersProps} />
          {showAdvancedMapOptions && <AdvancedLayersSection {…advancedProps} />}
          <LandmarkManagementCard onLandmarksChanged={level.reloadLandmarks} />
          <LandmarkSearchField {…} />
          {isAdmin && selectedDeposit && <AdminSelectedDepositBar {…} />}
        </>
      )}
      <div className={isFullscreen ? "absolute inset-0" : "relative"}>
        {previewActive && <ExitPreviewButton />}
        <MapViewerContainer {…viewerProps} />
        {showTranslocators && selectedTranslocator && <SelectedTranslocatorHeader {…} />}
        {isFullscreen && climateVisible && <ClimateHoverReadout floating {…} />}
        {isFullscreen && <FullscreenControlsOverlay {…} />}
      </div>
      <TLGroupingsDrawer {…} />
      <RoutePlannerPanel />
      <GoToDialog {…} />
      <WCOfficialDownDialog {…} />
    </Card>
  );
}
```

Target: **≤ 500 lines** in the page file after refactor. If you hit ≤ 700 with all invariants preserved, that is still a success — do **not** sacrifice correctness to hit a line count.

## What NOT to do (common pitfalls)

- Do not turn `useAppSelector` reads into "read the whole slice once" via `useAppSelector((s) => s.mapView)` — that would broaden re-render triggers. Keep individual selectors.
- Do not replace `useCallback` handlers with inline arrow functions when passing to child components. That would change identity semantics for memoized children.
- Do not extract a hook that captures `apiKey`, `dispatch`, or `queryClient` in a way that makes its returned callbacks re-create every render if they don't today.
- Do not merge the two viewer JSX blocks by adding a spread of `{...(usingWebCartographer ? wcProps : mapProps)}` — TS will fight you and the resulting prop set is subtly different. Prefer two adjacent, explicit JSX blocks or two small wrapper components.
- Do not "fix" the `finalOverlayPoints = previewActive ? [] : landmarkPoints` empty-array identity churn. Leave it.
- Do not remove any of the `// eslint-disable-next-line react-hooks/exhaustive-deps` directives. They exist for the one-shot mount effects and must move with those effects.
- Do not delete the two commented-out blocks (`{/* {!usingWebCartographer && ( */}` around the recently-added row, and the commented ResourcesDrawer). Preserve them verbatim.

## Verification checklist (run before declaring done)

- [ ] `tsc --noEmit` clean for `frontend`.
- [ ] Lint clean for every new and touched file (no new disables).
- [ ] `TOPSMapViewPage.tsx` re-exported under the same name from the same path.
- [ ] Every import path in the app that references `TOPSMapViewPage` still resolves (grep the workspace).
- [ ] Manual smoke: with `pnpm --filter frontend dev`, open the TOPS Map page and confirm:
  - Both `mapSource` tabs (WebCartographer and Cairn) render the map with the same overlays visible/hidden as before.
  - Toggling every switch in Layers and Advanced Layers has the same effect.
  - Ctrl/Cmd+G opens the Go-To dialog; Enter jumps; Escape cancels route pick-mode.
  - Route planner: pick "From" on map, pick "To" on map, a route renders and the toolbar ETA pill appears.
  - Home button jumps to saved home (or 0,0). "Save current as home" persists across reload.
  - Fullscreen toggle from `FullscreenControlsOverlay` still works and shows/hides the same panels.
  - `?auction=sell|buy|both|1` deep link still enables the auction heatmap.
  - `?level=&x=&z=&zoom=` deep link still restores the exact viewport.
- [ ] Grep the diff for any accidental behavior change: `grep -n 'refetchOnMount\|staleTime\|gcTime\|meta:' new-files/` should match the values in the original.
- [ ] Final line count of `TOPSMapViewPage.tsx` is reported in the summary.

## Deliverable

At the end, output:

1. A short bullet list of every new file created, grouped by phase.
2. Any step you skipped and why (with the specific behavior risk that made you skip).
3. Final line counts: old page, new page, and total lines added across new files.
4. The command(s) used for type-check and lint, and their exit codes.

Do not open a PR, do not push, do not amend commits — just leave the working tree with the changes applied and print the summary.

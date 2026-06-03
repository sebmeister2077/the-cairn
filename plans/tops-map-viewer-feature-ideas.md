# TOPS Map Viewer — Feature Ideas

A brainstorm of additional features for the TOPS webmap viewer, organized by theme.
Each item notes rough scope (S/M/L), and whether it's primarily client-only, server-backed, or admin-only.
Items are intentionally not yet prioritized — pick from this menu.

Existing features inventoried in [Architecture.md](../Architecture.md), [docs/multiplayer/tops-map.md](../docs/multiplayer/tops-map.md), and [frontend/src/components/tops-map/](../frontend/src/components/tops-map/). Already-planned items in `plans/` are not duplicated here.

---

## 1. Navigation & viewport

- **Traverse mode** *(M, client)* — already in [todos.md](../todos.md). Pick a TL grouping and step through it with `Next`/`Prev` keys; map auto-pans/zooms to the next TL endpoint, with optional auto-fit to show both endpoints of a leg. Designed for use alongside the running game.
- **Mini-map / overview inset** *(S, client)* — a small fixed-corner low-res map showing the current viewport rectangle and overall world extents; click to jump.
- **Coordinate jump box** *(S, client)* — paste `x, z` (or `x, y, z`, or chat-style `=22000, 110, -34000=`) and center the map; also paste a TL command and detect endpoints.
- **Right-click context menu on the map** *(M, client)* — "Copy coords", "Set as Route start/end", "Add as landmark", "Add as TL endpoint", "Pan home", "Open in WebCartographer", "Open in Cairn".
- **Measurement tool** *(S, client)* — click two or more points and show straight-line block distance, walking ETA at current speed, and bearing.
- **Compass / scale bar** *(S, client)* — persistent 1000-block scale bar and N indicator, useful for screenshots.
- ✅ **Keyboard shortcuts overlay** *(S, client)* — `?` opens a modal listing all bindings; arrow-key panning, `+/-` zoom, `H` home, `F` fullscreen, `R` route-from-here, `T` toggle TLs, etc.
- **Bookmarks** *(S, client)* — local-storage list of named viewport states (level + center + zoom + active overlays); cross-tab sync like TL groupings.
- **"Open in game" deep links** *(S, client)* — copy a `/tp` or `/wp` command for a clicked location.

## 2. TL groupings — beyond the current drawer

- **Server-synced groupings (opt-in)** *(L, server)* — currently local-only. Optional account-level sync so a player can use the same groupings on multiple devices, with conflict resolution.
- **Shareable grouping URLs** *(M, server or compressed-URL)* — paste a link that loads someone else's grouping into `view`/`filter`/`highlight` mode. Either short-link service (server) or base64+gzip in URL hash (client-only).
- **Public grouping gallery** *(L, server)* — moderated list of community groupings (e.g. "Northern trader loop", "Spawn → Resonance archive route") with upvotes and tags.
- **Per-grouping color rendering on the map** *(M, client)* — currently colors are stored but only used in chips. Render edges/markers in the grouping color when in `highlight`/`filter` mode; legend overlay shows active groupings.
- **Search inside groupings drawer** *(S, client)* — filter groupings by name/tag and TLs by endpoint label.
- **Auto-grouping suggestions** *(M, client)* — propose groupings from common patterns: "all TLs within 2k of spawn", "TLs forming a connected component reachable from X", "loops".
- **Bulk TL editor** *(S, client)* — multi-select TLs (lasso/box select on the map) and add/remove from a grouping in one shot.

## 3. Route planner — extensions

- **Multi-stop routing** *(M, client)* — more than 2 endpoints, optional reorder-for-shortest (TSP-lite up to ~8 stops).
- ✅ **Avoid-list** *(S, client)* — temporarily exclude specific TLs/landmarks from routing (e.g. broken TL, hostile area).
- **Region preferences** *(M, client)* — bias routes away from oceans, deserts, glaciers using existing climate/oceans data; soft cost layer.
- **Walkable-only or TL-only modes** *(S, client)* — quick toggle to compare "no TLs" vs "TLs only" routes.
- **Elevation-aware ETA** *(M, client)* — incorporate `RainHeightMap` or terrain to surface large climbs; show elevation profile chart.
- **Saved routes for the current user** *(M, server)* — separate from "save for road workers": personal route library, optionally synced. Quick-load into the planner.
- (OK) **Route export formats** *(S, client)* — copy as numbered waypoint commands (already done), but also as JSON, CSV, or a printable cheat-sheet.
- **Group rendezvous live tracker** *(L, server)* — players opt in by pasting current coords periodically; map shows everyone in the rendezvous and recomputes the meeting point. Privacy-gated.
- **"Route from here" pin** *(S, client)* — right-click → set the click as start, then click destination on the map.

## 4. Search & discovery

- **Global search palette** *(M, client)* — `Ctrl+K`-style omnibar that searches TLs, landmarks, traders, waypoints, regions, groupings, bookmarks, and saved routes in one list.
- **Filter chips for landmarks** *(S, client)* — by type, age, contributor, "near me", "verified".
- **Trader inventory search** *(L, server)* — if players can submit trader stocks/prices, search e.g. "who sells temporal gears within 5k of spawn".
- **Region browser** *(M, client)* — list all regions with stats (chunk count, similarity to canonical, contribution age) and click-to-jump.
- **What's new feed** *(M, server)* — chronological feed of recently added TLs, landmarks, region updates, with click-to-jump.

## 5. Layers & overlays

- ✅ **Climate / temperature heatmap** *(M, server)* — already partly available via worldgen sample; expose as toggleable layer with legend.
- ✅ **Forest density layer** *(M, server)* — same data path.
- ✅ **Rock strata** *(M, server)* — from worldgen sample; show dominant strata with color coding and legend.
- **Top-rock layer** *(M, server)* — color the surface by `TopRockIdMap` (granite/andesite/basalt/chalk/sandstone/...). Critical for prospecting and aesthetic builds, and already partially indexed by the cairn pipeline.
- **Rock-strata cross-section probe** *(M, server)* — click a point and see the projected rock column (top → bedrock) based on worldgen layer config; not a full overlay but a layer-aware tool.
- **Crop suitability picker** *(M, client+server)* — pick a crop (flax, rice, rye, soybean, ...) and shade tiles green/red for "can grow here" using crop temperature/moisture ranges.
- **Temperature heatmap (yearly avg / Jan / Jul)** *(M, server)* — `WorldGenTemperature` sampled at a sparse grid; toggle between annual mean and seasonal extremes. Drives crop/honey/livestock viability.


- **Biome / region boundary overlay** *(M, server)*.


### 5a. Vintage Story–specific overlays

Worldgen and game-data driven layers unique to VS. Most are derivable from `IBlockAccessor.GetClimateAt(...)` (worldgen mode), `IMapChunk.TopRockIdMap` / `RainHeightMap`, deposit generators, and entity/structure spawn rules — same data path as the existing resources overlay.

**Terrain & topography**
- **Elevation / hillshade layer** *(M, server)* — render a shaded-relief map from `RainHeightMap`. Toggleable hillshade, contour lines every N blocks, and a "sea level boundary" highlight.
- **Slope / walkability layer** *(M, server)* — gradient of terrain steepness; useful for road-builders and elk routes (pairs with elk-walkable contributions).
- **Cave / underground entrance hints** *(M, server)* — flag chunks with significant overhang or pit features detected from the rendered tile alpha or height variance.
- **Top-rock layer** *(M, server)* — color the surface by `TopRockIdMap` (granite/andesite/basalt/chalk/sandstone/...). Critical for prospecting and aesthetic builds, and already partially indexed by the cairn pipeline.
- **Rock-strata cross-section probe** *(M, server)* — click a point and see the projected rock column (top → bedrock) based on worldgen layer config; not a full overlay but a layer-aware tool.

**Climate & biome**
- **Temperature heatmap (yearly avg / Jan / Jul)** *(M, server)* — `WorldGenTemperature` sampled at a sparse grid; toggle between annual mean and seasonal extremes. Drives crop/honey/livestock viability.
- **Rainfall layer** *(M, server)* — `WorldgenRainfall`; pair with temperature for biome inference.
- **Forest density layer** *(M, server)* — `ForestDensity`; helpful for finding clearings, dense logging spots, or rare-tree biomes.
- **Tree-species probability overlay** *(M, server)* — derived from temp+rain+forest density: where birch, kapok, acacia, larch, etc. dominate. Especially valuable for fruit trees (rare cultivars).
- **Fruit-tree / berry-bush hotspots** *(M, server)* — same data path, filtered to edible species.
- **Biome / Köppen-style classification** *(M, server)* — derived layer combining temp + rain + forest into named biomes (taiga, temperate, savanna, tropical, ...).
- **Crop suitability picker** *(M, client+server)* — pick a crop (flax, rice, rye, soybean, ...) and shade tiles green/red for "can grow here" using crop temperature/moisture ranges.
- **Beehive / wild bee suitability** *(S, server)* — flowers + warm temperate climate; a niche but heavily-asked overlay.
- **Permafrost / glacier line** *(S, server)* — temperature isotherm overlay marking always-frozen ground.
- **Sea-ice line** *(S, server)* — winter freeze boundary, useful for boat routes.
- **Ocean depth / shallows** *(M, server)* — extend the existing oceans overlay with bathymetry (shallow → deep gradient) for boat travel and fishing.
- **Fishing hotspots** *(S, server)* — derived from water-body size + climate, mark good cod/salmon/trout zones.

**Resources & prospecting (extending the resources overlay)**
- **Per-ore richness gradient** *(M, server)* — already in the resources bundle; expose finer-grained richness contours per deposit type rather than binary presence.
- **"Find me X" search-as-overlay** *(M, server)* — type "cinnabar" and the map highlights every chunk where the deposit generator returns a non-zero abs-quantity.
- **Salt / halite layer** *(S, server)* — saltpeter and salt deposits get their own toggle (commonly hunted for, currently lumped with other surface ores).
- **Clay / peat / bog-iron layer** *(S, server)* — surface materials that are climate-gated rather than deposit-gated.
- **Rare-rock outcrops** *(S, server)* — rhyolite, kimberlite, phyllite chunks where the top-rock map has rare ids.
- **Prospecting-pick simulator overlay** *(M, server)* — given a chunk, predict the in-game `/proPick` density readings without visiting; respects ore-map factor.
- **Meteorite / impact crater layer** *(S, server)* — if structure-spawn data is exposed, mark crater locations.

**Structures & POIs**
- **Ruins / villages / structures overlay** *(M, server)* — generated structures (storyworld ruins, villages, towers, translocator pillars). Many players want this independent of community landmarks.
- **Story locations** *(S, server)* — Resonance Archives, Devastation, fragmented temporal storms, etc.
- **Trader-village proximity layer** *(S, server)* — heatmap of "nearest trader" distance, useful for picking a base.
- **Wolf / drifter / locust spawn-density layer** *(M, server)* — derived from biome + climate + surface-cave proximity; helpful for safe-route planning at night.
- **Surface-drifter risk by lat/temporal-stability** *(M, server)* — temporal stability falls off with distance from spawn; show a stability gradient (also relevant for temporal storm survival).
- **Temporal-storm intensity layer** *(S, server)* — same data, exposed as its own toggle.

**Civilization & community**
- **Player-base / settlement clusters** *(M, server)* — derived from clusters of user-uploaded waypoints with home-marker icons; opt-in.
- **Active region heatmap** *(M, server)* — chunks contributed within the last N days (already partly via "recent TLs" filter; generalize to all chunk uploads).
- **Road network overlay** *(M, server)* — community-submitted roads as polylines, distinct from TLs and walkable edges. Already noted above; VS-specific because it pairs with the road-workers flow.
- **Claim / land-claim overlay** *(L, server)* — if server admins can export claim regions, render them as semi-transparent polygons.

**Quality of life**
- **Spawn-radius rings** *(S, client)* — concentric rings at 1k/5k/10k/40k from world spawn; classic VS reference.
- **Translocator-link overlay (link lines)** *(S, client)* — draw straight lines between every TL pair currently visible, color-coded by length; quickly spot dead-end TLs and clusters.
- **Coordinate grid** *(S, client)* — toggleable 1k or 5k chunk grid with labels.
- **"Where am I now" pin from in-game** *(M, server+mod)* — companion mod posts the player's current chunk; viewer renders a live pin.

## 6. Annotations & community content

- **User pins / notes** *(M, server)* — private personal pins; optionally publish for moderation into landmarks.
- ✅ **Photo waypoints** *(M, server)* — attach an in-game screenshot to a landmark (already partly handled by landmark images; expose in viewer with lightbox + EXIF-of-game-time).
- **Comments on landmarks/TLs** *(M, server)* — short threaded notes; moderated.
- **Voting / reputation on contributions** *(M, server)* — upvote/downvote helpful TL or landmark entries; trust score feeds into map prominence.
- ✅ **"Stale data" flagging** *(S, server)* — players can flag a TL as broken/missing-in-world; threshold triggers admin review.

## 7. Sharing & embedding

- **Open-graph snapshot endpoint** *(M, server)* — `/api/tops-map-snapshot?bbox=…&overlays=…` returns a PNG with overlays burned in for link previews.
- **Embeddable iframe widget** *(M, server)* — minimal viewer for blogs/wikis with locked viewport.
- **Permalink shortener** *(M, server)* — for current view + active overlays + planner state.
- **Print/export current view** *(S, client)* — download the visible canvas as PNG/PDF with a legend.
- **Twitch/Discord rich-embed** *(S, server)* — proper meta tags on share URLs.

## 8. Performance & UX

- **Vector overlays via MapLibre/Leaflet** *(L, refactor)* — replace bespoke overlay layer with a tiled vector engine; gains: smooth zoom, native clustering, GPU rendering of thousands of waypoints.
- **Marker clustering** *(M, client)* — cluster TLs/waypoints/landmarks at low zoom levels.
- **Service-worker tile cache** *(M, client)* — explicit offline cache of recently viewed levels with quota and "clear cache" UI.
- **Progressive overlay loading** *(S, client)* — show TLs first, then landmarks, then traders rather than waiting on all of them.
- **Skeleton/placeholder tiles** *(S, client)* — instead of blank canvas while stitching.
- **Reduced-motion / low-power mode** *(S, client)* — disable starfield + animations behind a toggle and via `prefers-reduced-motion`.

## 9. Accessibility & i18n

- **Keyboard-only navigation** *(M, client)* — fully tabbable panels, ARIA on toggles, focus trap in drawers; map pan via keys already partly there.
- **Screen-reader summaries** *(M, client)* — "12 translocators visible, 3 landmarks, current center 22000, -34000".
- **High-contrast theme + colorblind-safe palettes** *(S, client)* — alt palettes for trader/TL category colors.
- **Localized UI** *(L, client)* — i18n of viewer strings; piggyback on [docs/technical/i18n.md](../docs/technical/i18n.md).

## 10. Mobile & touch

- **Mobile-first overlay layout** *(M, client)* — bottom-sheet drawers instead of side drawers below a breakpoint.
- **Two-finger rotate / pinch parity** *(S, client)* — full gesture set with sensible inertia.
- **PWA install + offline shell** *(M, client)* — pairs with service-worker tile cache.

## 11. Game-version & temporal

- **Game-version overlay** *(M, server)* — referenced in [game-version-overlay-plan.prompt.md](game-version-overlay-plan.prompt.md); confirm status and finish if dormant.
- **Time-slider / map history** *(L, server)* — scrub a date slider; viewer shows the map / TL set as it was on that day. Requires snapshot retention strategy.
- **Diff view between two snapshots** *(L, server)* — highlight added/removed/changed chunks between dates; useful for moderators.
- **"Show only data newer than X"** *(S, client)* — generalize the existing 14-day TL emphasis filter to all overlays.

## 12. Admin & moderation

- **Inline admin tools on right-click** *(M, server)* — for admins, context-menu actions: lock TL, hide landmark, mark region for re-render.
- **Pending-contribution queue overlay** *(M, server)* — visualize all pending elk-walkable, landmark, and TL submissions on the map with quick approve/reject.
- **Audit trail viewer** *(M, server)* — already exists at [audit-log.md](../docs/users/audit-log.md); surface a timeline overlay for "what changed in this region".
- **Region revert tool** *(L, server)* — partly addressed by contribution-improvement plan; expose a UI to revert a region to a specific snapshot from inside the viewer.
- **Bulk landmark moderation** *(M, server)* — multi-select edit-requests in one panel.

## 13. Analytics for the map owner

- **Heatmap of viewer activity** *(M, server)* — anonymized "where do users look" heatmap to inform pre-rendering priorities.
- **Most-used TLs and landmarks** *(S, server)* — derived from route planner + bookmarks + clicks.
- **Conversion funnel** *(S, server)* — map view → contribution flow drop-off.

## 14. Game integration / power-user

- **Mod companion** *(L, mod)* — Vintage Story mod that listens for in-game events and pushes/pulls to the viewer (e.g. waypoint sync, current-position pin). Pairs with existing waypoint upload flow.
- **REST/JSON read API** *(M, server)* — documented endpoints to fetch TLs, landmarks, traders, regions; enables third-party tools and the eventual mod.
- **Webhook on contribution events** *(S, server)* — for Discord notifications.

## 15. Fun & engagement

- **Daily "explorer challenge"** *(M, server)* — random uncharted region highlighted; first to upload chunks wins a leaderboard slot.
- **Achievements / badges** *(M, server)* — for landmark contributions, route saves, elk-walkable attestations.
- **Time-lapse of the map** *(M, server)* — auto-generated short clip of the world growing over time, regenerated weekly.

---

## Quick-win shortlist (cheap, high value)

1. Coordinate jump box + right-click context menu (1.3, 1.4).
2. Measurement tool (1.5).
3. Keyboard shortcuts modal (1.7).
4. Bookmarks (1.8).
5. Per-grouping color rendering on map (2.4).
6. Search inside groupings drawer (2.5).
7. Multi-stop routing (3.1) and avoid-list (3.2).
8. Layer presets and per-overlay opacity (5.8, 5.9).
9. Print/export current view (7.4).
10. Reduced-motion mode (8.6).

These are mostly client-only, build on existing infrastructure, and don't require new backend tables.

## Bigger bets

- Vector-tile refactor (8.1) — unlocks clustering, performance, animation.
- Time-slider / map history (11.2) — uniquely valuable for a multi-year persistent world.
- Server-synced groupings + public gallery (2.1, 2.3).
- Mod companion + read API (14.1, 14.2) — closes the loop with the game.

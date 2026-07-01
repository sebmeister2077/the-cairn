# Auction House Data Explorer — Plan

A **public**, read-only market-analytics section built from the in-game Auction House capture
data (`frontend/src/assets/Auction/auction-events.jsonl`). Four surfaces: filterable listings
table, price statistics / fair-price finder, map heatmaps (sell/buy + trade routes), and
leaderboards + player profiles.

Currency is **Rusty Gears**. `TraderCut` (~10%) is the auction-house fee.

## Confirmed decisions
- **Item names:** user will export a full `itemId → code/name` map from the game; the preprocess
  script joins it. Falls back to raw IDs if the map is absent.
- **Data delivery:** a **manual Python preprocess script** turns the raw JSONL into compact,
  pre-aggregated JSON artifacts written to `frontend/public/auction/`, fetched at runtime via
  React Query. (R2 is an easy later swap — same fetch, different base URL.) Chosen over bundling
  because the dataset grows and this keeps it out of the JS bundle.
- **Audience:** PUBLIC.
- **v1 scope:** all four areas. Build order: **table → price stats → heatmaps → leaderboards**.

## Data facts, gotchas & corrections (integrated)
1. **Dedup to latest state is REQUIRED (correctness risk #1).** The raw file is only partly
   deduplicated: 16,582 rows but 14,680 unique `AuctionId`s — 1,639 auctions appear 2–3× as they
   progress `Active → Sold → SoldRetrieved` or `Active → Expired`. Preprocess must collapse to one
   row per `AuctionId`, keeping the newest by `lastObservedUtc` (prefer terminal states).
   States seen: Expired 12,058 · Active 2,151 · Sold 1,692 · SoldRetrieved 681.
2. **`EntityId` is NOT stable.** `SellerEntityId` / `SrcAuctioneerEntityId` change between
   observations (entities respawn). Identify **players by `SellerUid`/`BuyerUid`** and **cluster
   auctioneers by rounded coordinates**, never by entity id.
3. **Filter test/spam noise.** Some sellers post huge volumes at flat prices (e.g. `111`, `1111`)
   that never sell. Compute fair-price from **sold listings only**, and add an
   "exclude outliers / sold-only" toggle so spam doesn't pollute stats and leaderboards.
4. **`Item.Id` / `Item.StackSize` in the JSON are unreliable** (oddly packed). `Item.RawHex` is
   authoritative: `[int32 classType 1=Item/0=Block][int32 itemId LE][int32 stackSize]
   [TreeAttribute…][00]`. Decode in preprocess; keep key attributes (type, condition, category).
5. **Two clocks.** Real-world = `observedUtc`/`lastObservedUtc`/`observationCount`. In-game
   calendar = `PostedTotalHours`/`ExpireTotalHours`/`RetrievableTotalHours`/`InitialDurationHours`.
   Early listings were captured retroactively (observationCount up to 250) → use in-game hours for
   time-to-sell, not first-seen time.
6. **Derived metrics:** `pricePerUnit = Price/stackSize`; `sellThrough = sold/(sold+expired)`;
   `timeToSellHours ≈ RetrievableTotalHours − PostedTotalHours` (sold only); `isDelivered = WithDelivery`;
   `tradeDistance` from Src↔Dst (delivered only, Dst=0 when not delivered).
7. **Currency label = Rusty Gears**; expose net-of-fee revenue on leaderboards.
8. **Data-freshness banner:** show "last updated X" (from artifact `generatedUtc`) since refresh
   is manual.

## Phases

### Phase 0 — Preprocess pipeline (`backend/process_auction_data.py`, manual run)
- Read JSONL; **dedup to latest per `AuctionId`** (gotcha 1); decode `RawHex` ItemStack (gotcha 4);
  join `itemId → name/category` from an optional `item-map.json` (fallback to raw id); derive
  fields (gotcha 6); flag likely spam (gotcha 3).
- Emit to `frontend/public/auction/`:
  - `listings.json` — compact per-auction rows (no RawHex), for the table & client filtering.
  - `summary.json` — precomputed aggregates: per-item stats (median/p10/p25/p75/p90, volume,
    sellThrough, medianTimeToSell), leaderboards (top sellers/buyers/items, biggest sales),
    heatmap Src/Dst grid bins, market totals (cap, volume, sell-through), time series, `generatedUtc`.
  - `items.json` — id → name/category catalog.
- Print artifact sizes; sanity-check a few decoded items.

### Phase 1 — Frontend data layer + scaffolding
- Add `/market` category + routes in `frontend/src/components/AppContent.tsx` (NavigationRoutes +
  Routes JSX + i18n nav labels).
- `frontend/src/models/auction.d.ts` — shared types.
- `frontend/src/lib/auction.ts` — React Query fetchers for the 3 artifacts (persisted cache).
- Redux `auctionFilters` slice (search, itemId, category, priceMin/Max, state, delivery, seller,
  buyer, soldOnly/excludeOutliers, sort) mirroring `store/slices/adminUsersFilters.ts`; register
  in the store + persistence + hydrate.

### Phase 2 — Listings table + filters (priority)
- `MarketListingsPage`: shadcn `Table` (pattern from `WaypointTable.tsx`), virtualized via
  `@tanstack/react-virtual`. Columns: item, price, price/unit, qty, seller, buyer, state badge,
  location, delivery, date. Client sort + filter bar (price range, item/category select, state
  toggles, sold-only/exclude-outliers, text search); filters live in the React Query key.

### Phase 3 — Price stats / fair-price finder
- Per-item detail: price-per-unit histogram + **log-normal** fit (NOT normal), StatCards
  (median/percentiles, sellThrough, medianTimeToSell), price trend via `usage/TimeSeriesChart.tsx`,
  sold vs expired. Fair-price = median of **sold** listings with over/under-priced bands.

### Phase 4 — Map heatmaps
- `MarketMapPage` using `MapViewer.tsx`: toggle sell(blue)/buy(red) heatmap from Src/Dst grid bins;
  auctioneer markers clustered by coords (WorldPointMarker); optional Src→Dst route lines
  (WorldLineSegment); trade-distance / regional-price insights.

### Phase 5 — Leaderboards + player profiles
- Leaderboards page (top sellers/buyers by net-of-fee revenue & volume, most-traded items, biggest
  sales) via StatCard + tables. `/market/player/:uid` profile: their listings, favorite items,
  trade locations, sell-through, stats.

### Phase 6 — Overview dashboard + freshness banner
- Landing hub: market cap, volume, total listings, sell-through, top items (StatCards + charts),
  data-freshness banner, links to sub-pages.

## Verification
1. Run preprocess; confirm dedup count (unique AuctionId), decoded items match known samples,
   itemId→name join correct, artifact sizes reasonable.
2. Load `/market`; filters drive the table; chart medians match a hand-computed sample.
3. Heatmap markers align with a known trader's world coords in `MapViewer`.
4. Leaderboard net revenue reconciles with a manual aggregate over the JSONL.

## Open considerations
- **Scale:** client-side filtering is fine up to ~100k rows compressed; beyond that add a backend
  query endpoint (swap `lib/auction.ts` fetchers). Aggregates already precomputed to keep client light.
- **Variants:** group by `itemId`; expose top attributes (condition/type) as extra filter facets
  rather than separate items.
- **Icons:** text names only for v1.

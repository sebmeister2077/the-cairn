---
mode: agent
description: Pre-render contribution previews after validation and vectorize match-score pixel sampling
---

# Contribution flow perf — pre-render preview + vectorize match score

Two follow-ups to the May 2026 perf pass that landed atomic cache promotion
and incremental tile counting in the approval merge. These two target the
*pre-approval* path (the part the admin actually waits on interactively):

1. Preview rendering — slow on first request (~15–60 s) because the
   admin's click is what triggers the full download + render.
2. Match-score pixel sampling — a Python-level decode loop that runs
   sequentially over every overlapping tile.

Both are non-blocking, non-destructive, and gated by existing feature
flags / kill switches.

---

## #2 Pre-render the preview as soon as validation succeeds

### Current behavior

- `validate_uploads` worker downloads the pending DB, runs `_validate_upload`,
  flips `validation_status = 'valid'`, deletes the temp file, exits.
- First admin to open the contribute page hits `GET /contribute/preview/{id}`
  which finds no cached PNG in R2 and synchronously:
  1. Acquires per-contribution `asyncio.Lock`
  2. Calls `get_combined_db_cached()` (usually a hit)
  3. Downloads the pending DB **again** (validation already had it but
     threw the temp file away)
  4. Runs `_render_preview` at `max_dimension=2048` in `asyncio.to_thread`
  5. Uploads PNG to R2 at `pending/<id>.preview.png`
- Subsequent loads are R2-hit and fast.

Bottleneck: the admin's first preview load is 15–60 s end-to-end, and the
pending DB is downloaded twice (once for validation, once for preview).

### Proposed

After `db.set_validation_valid(cid, tile_count)` succeeds in
[backend/app/tasks/validate_uploads.py](../backend/app/tasks/validate_uploads.py)
`_process_one`, render the preview inline while the temp pending DB is
still on disk and the combined DB cache is hot.

#### Key implementation points

- Keep the temp pending file alive past `set_validation_valid`. Currently
  the `finally` block unlinks `tmp_path` before any preview work could
  happen. Restructure so we call the preview routine **before** the unlink.
- Reuse the existing renderer. `_render_preview(...)` and the preview
  caching glue live in
  [backend/app/routes/contribute_r2.py](../backend/app/routes/contribute_r2.py)
  around `contribute_preview()` (~L2428). Extract the cache-miss body of
  that handler into a sync helper, e.g.
  `_render_and_cache_preview(cid, pending_path, combined_path) -> None`,
  that:
  1. Builds the green-tint PNG via `_render_preview`
  2. Writes to a temp PNG, uploads to `pending/<id>.preview.png`
  3. Cleans up the temp PNG
- The HTTP handler then becomes a thin wrapper that, on cache miss, calls
  the same helper (so on-demand and post-validation paths share one
  implementation).
- The validation worker calls `_render_and_cache_preview(cid, tmp_path,
  get_combined_db_cached())` after the status flip. Wrap in
  `try/except Exception:` and log — preview failures must never poison
  validation success.

#### Coordination with the existing per-contribution `asyncio.Lock`

The worker runs in a daemon thread, not on the asyncio loop. The HTTP
handler currently uses `_PreviewLock` (an asyncio dedup primitive). Two
options:

- **Simple**: the validation worker writes directly to R2 *without*
  touching `_PreviewLock`. If an admin happens to hit the preview
  endpoint while the worker is mid-render, the handler may start a
  second redundant render. Cost: one wasted render in a narrow race
  window. Acceptable for v1.
- **Robust**: replace `_PreviewLock` with a Postgres advisory lock keyed
  on `hashtext('preview:' || cid)`. Both the HTTP handler and the
  validation worker take it. See [Improvement #5 in the perf review]
  — defer to a separate plan if scope creeps.

Recommend **Simple** for this plan.

#### Feature flag / kill switch

- Gate behind the same `heavy_compute_enabled` kill switch the validation
  worker already honors (see `is_heavy_compute_allowed()`). If a sysadmin
  wants to stop background CPU/IO during peak, the new render skips too.
- Add an explicit `PREVIEW_PRERENDER_DISABLE=1` env opt-out for tests
  (mirror of `MATCH_SCORE_DISABLE_STARTUP_KICK`).
- No new feature flag needed: pre-rendering is invisible to users — they
  just see faster previews.

#### Backwards compatibility

- Old pending rows already have validated status but no preview. Either
  let the on-demand render path keep handling them, or write a one-shot
  backfill script that walks `validation_status='valid' AND preview not in
  R2` and enqueues renders. Skip the backfill — the on-demand path is the
  fallback by design.

#### Tests

- Unit: validation worker happy-path now uploads `pending/<id>.preview.png`.
  Use `r2_storage` test double already used by `test_validate_uploads`.
- Unit: render-time exception in worker → validation still marked valid,
  preview missing, on-demand path still works.
- Integration: end-to-end upload → validation drain → assert
  `X-Preview-Cache: hit` on first `GET /contribute/preview/{id}`.

#### Expected gain

- Admin's first preview load drops from 15–60 s to ~1 s (R2 hit).
- One fewer multi-GB R2 download per contribution (preview reuses the
  in-memory pending DB the validator already downloaded).
- No change to approval latency or anything on the request path.

#### Files touched

- [backend/app/tasks/validate_uploads.py](../backend/app/tasks/validate_uploads.py) — call preview renderer before unlink, env opt-out.
- [backend/app/routes/contribute_r2.py](../backend/app/routes/contribute_r2.py) — extract `_render_and_cache_preview`, reuse in `contribute_preview` cache-miss branch.
- `backend/tests/test_validate_uploads.py` — new assertions.
- `docs/multiplayer/contribute.md` — one paragraph noting previews are pre-rendered.

---

## #4 Vectorize the match-score pixel sampling

### Current behavior

`_compute_match_score(combined_path, pending_path)` in
[backend/app/routes/contribute_r2.py](../backend/app/routes/contribute_r2.py)
(around L1546):

```python
for (pos, combined_blob, pending_blob) in attached_join_cursor:
    c_samples = mapdb._sample_n_pixels(combined_blob, 10, seed=pos)
    p_samples = mapdb._sample_n_pixels(pending_blob, 10, seed=pos)
    # +1 center pixel each
    matches = 0
    for ci, pi in zip(c_samples, p_samples):
        if alpha_zero_either(ci, pi): continue
        if abs(ci.r - pi.r) <= 6 and abs(ci.g - pi.g) <= 6 and abs(ci.b - pi.b) <= 6:
            matches += 1
    # ...
```

- ~11 sample comparisons per overlapping tile, all in Python.
- 100k overlapping tiles → ~1.1M comparisons sequentially.
- The seeded RNG ensures reproducibility; cannot drop that constraint.

### Proposed

Batch overlapping tiles into chunks of e.g. 4096 and vectorize with numpy.

#### Algorithm sketch

For each batch of rows from the `INNER JOIN ... ON position`:

1. Allocate four `numpy.uint8` arrays of shape `(B, 11, 4)` (B = batch
   size, 11 = samples per tile, 4 = RGBA):
   `c_samples`, `p_samples`. Fill row-by-row by calling the existing
   `mapdb._sample_n_pixels(blob, 10, seed=pos)` — but rewrite that helper
   to return a `numpy.uint8[11, 4]` instead of a Python list of tuples.
   Cost is dominated by `Image.open(BytesIO(blob))` decode, not the
   indexing.
2. Compute the alpha mask once:
   `valid = (c_samples[..., 3] > 0) & (p_samples[..., 3] > 0)`
   shape `(B, 11)`.
3. Compute the RGB delta:
   `diff = np.abs(c_samples[..., :3].astype(np.int16) - p_samples[..., :3].astype(np.int16))`
   shape `(B, 11, 3)`.
4. Per-sample match: `match = (diff <= 6).all(axis=-1) & valid`
   shape `(B, 11)`.
5. Per-tile tally:
   - `valid_n = valid.sum(axis=1)` — denominator per tile
   - `match_n = match.sum(axis=1)` — numerator per tile
   - `similar = match_n >= np.ceil(valid_n * 8 / 11)` (handle valid_n=0
     as "skip" → not counted toward `tiles_scanned`)
6. Aggregate batch totals into the running `tiles_scanned`,
   `tiles_similar`, sum-of-match-numerators, sum-of-valid-denominators.

The pixel-decode loop (PNG → 11-sample array) stays per-row because each
tile blob is independent. Vectorization wins on the comparison + tally
step which is currently ~50% of the time.

#### Where the actual time goes (profile first!)

Before writing any numpy, run the worker on a known large overlap
(reuse one of the recent ~100k-tile contributions). Wrap
`_compute_match_score` in `cProfile` and dump to a `.prof` file. Confirm
the suspected hot path:

- If `Image.open(BytesIO(...))` dominates → vectorization helps less
  than swapping PNG decode for `PIL.Image.frombytes` on raw RGBA blobs
  (the storage format is already raw RGBA on disk per
  [docs/multiplayer/map-database-format.md](../docs/multiplayer/map-database-format.md)
  — verify this!). Possible 5× separate win.
- If the inner Python comparison loop dominates → vectorization gives
  the expected 5–20×.

Pick whichever the profile says, implement that one. **Do not implement
both at once** — keep the change minimal.

#### `_sample_n_pixels` rewrite

Current signature in [backend/app/core/mapdb.py](../backend/app/core/mapdb.py):

```python
def _sample_n_pixels(blob: bytes, n: int, seed: int) -> list[tuple[int, int, int, int]]:
```

New signature (additive — keep old one for any other callers, or audit
and switch them all):

```python
def _sample_n_pixels_np(blob: bytes, n: int, seed: int) -> np.ndarray:
    """Return shape (n+1, 4) uint8 RGBA samples. Last row is the center."""
```

Determinism contract: the existing `random.Random(seed).sample(...)`
behavior MUST be preserved exactly so historic match scores recomputed
on the same contribution still yield the same number. Pin to
`random.Random` (not `numpy.random`) for index selection.

#### Feature flag

Already exists: `match_score`. No new flag.

For rollout safety add an env opt-out:
`MATCH_SCORE_VECTORIZED_DISABLE=1` — if set, fall back to the legacy
Python loop. Keep both code paths for one release, delete the legacy
loop in the next.

#### Tests

- Determinism: golden tests on a fixture pending DB asserting
  `pixel_similar_pct`, `tile_overlap_pct`, `overlap_count`,
  `tiles_similar` all match the legacy values bit-for-bit.
- Edge cases: zero overlap, single-tile overlap, all-transparent tiles,
  partial-alpha tiles.
- Perf smoke: measure wall time on a fixture with ≥10k overlapping tiles
  before / after; assert ≥3× speedup (loose floor to avoid flaky CI).

#### Expected gain

- 5–20× on the comparison stage. End-to-end match-score job time for a
  100k-overlap contribution: ~30 s → ~3–10 s, depending on whether
  PNG decode also gets optimized.
- No change to determinism, scoring thresholds, or frontend display.

#### Files touched

- [backend/app/core/mapdb.py](../backend/app/core/mapdb.py) — add `_sample_n_pixels_np`.
- [backend/app/routes/contribute_r2.py](../backend/app/routes/contribute_r2.py) — rewrite `_compute_match_score` inner loop.
- `backend/tests/test_match_score.py` — golden tests + perf smoke.
- `backend/requirements.txt` — numpy is presumably already pulled in by
  the renderer; verify, no change expected.

---

---

## #6 Wire `_render_preview` through the Tier 3.2 sidecar cache

### Current behavior

`_render_preview` in
[backend/app/routes/contribute_r2.py](../backend/app/routes/contribute_r2.py)
opens the combined DB with a raw `SELECT position, data FROM mappiece`
cursor and calls `decode_tile_numpy(blob)` / `decode_tile_fallback(blob)`
on every tile. That's the canonical varint decode path — exactly the
work that Tier 3.2 (the sidecar RGBA cache at `<combined>.cache.db`)
exists to skip.

The cache is already kept warm by the approval merge: see
`incremental_update_cache(...)` called after every successful merge in
the same function the May 2026 atomic-promotion edit lives in. Regen,
tops-map render, and chunk render all route through
`_iter_tiles_for_range(db_path, src_conn, pos_min, pos_max)` in
[backend/app/core/mapdb.py](../backend/app/core/mapdb.py) which
transparently prefers the sidecar when fresh.

`_render_preview` is the only major render path that doesn't.

### Proposed

For the **combined-side** paint pass (which is 99% of the cost on a
real-world preview — admin reviewing a tiny contribution against a
30 M-tile combined map), route through `_iter_tiles_for_range` so a
warm sidecar skips the varint decode.

Pending-side paint pass keeps the canonical decode — pending DBs are
small (typically <100 k tiles), have no sidecar of their own, and
building one just for the preview isn't worth the I/O.

### Key implementation points

- Only swap the `scale <= TILE_SIZE` branch. The `scale > TILE_SIZE`
  per-pixel branch (only hit on >65 k-chunk worlds, very rare) keeps
  reading 11 raw varint bytes per tile via `_sample_one_pixel` — going
  through the iterator would force a full RGBA decode per tile just to
  sample one pixel from it, a regression on those rare giant maps.
- The iterator yields `(pos_val, rgba_tile)` where `rgba_tile` is
  already a `(32, 32, 4)` `uint8` numpy array — drop the
  `decode_tile_numpy`/`decode_tile_fallback` branching.
- Highlight tint (`R*0.5; G=min(G*0.5+128, 255); B*0.5`) is applied
  after decode, regardless of source — unchanged.
- Use the existing `MAPDB_DISABLE_CACHE=1` env switch — already
  honored by the iterator.

### Feature flag / kill switch

None new. `MAPDB_DISABLE_CACHE=1` already disables the sidecar globally.

### Tests

- Golden: existing preview fixture renders byte-identical with and
  without a sidecar present (cache fall-through is documented as
  behaviourally transparent).
- Smoke: same fixture, with a freshly-built sidecar, asserts wall time
  at least 30% lower than without (loose floor for CI).

### Expected gain

- Combined-side paint roughly halves in wall time once the cache is
  warm (the same ~2× the regen / tops-map paths get).
- On a representative 50 k-tile contribution against a 30 M-tile
  combined map at `max_dimension=2048`: preview render drops from
  ~15–25 s to ~8–12 s on cache hit.
- Pairs naturally with #2 (pre-render after validation): #2 makes the
  admin almost never hit the slow path, #6 halves the cost when they
  do.

### Files touched

- [backend/app/routes/contribute_r2.py](../backend/app/routes/contribute_r2.py)
  — swap `_paint_tiles`'s `scale <= TILE_SIZE` branch to use
  `_iter_tiles_for_range`.
- `backend/tests/test_render_preview.py` — golden + smoke.

### Risks

- Sidecar may not exist for a freshly-deployed instance (the post-merge
  `incremental_update_cache` is the only writer). The iterator already
  handles that case transparently — render is no slower than today on
  cache miss.
- Sidecar can lag the canonical DB by a few hundred ms during the
  approval merge. The `is_cache_fresh` mtime check in `mapdb_cache`
  invalidates a stale sidecar so we never serve outdated pixels.

---

## Out of scope (separate plans)

- Cross-worker preview deduplication via Postgres advisory locks (perf
  review item #5). Useful only once we scale past one uvicorn worker.
- Streaming R2 → SQLite for validation. Probably not worth the
  complexity at current DB sizes.
- Render plan upgrade. Infrastructure, not code.

## Order of execution

1. Profile `_compute_match_score` on a real ~100k-overlap fixture.
   This decides whether the #4 win is in numpy vectorization or PNG
   decode replacement.
2. Land #2 (pre-render preview) first — it's smaller, lower-risk, and
   gives the most visible win to admins.
3. Land #6 (wire preview through Tier 3.2 sidecar) — tiny change,
   reuses existing infra, halves cold-preview cost.
4. Land #4 based on the profile result.

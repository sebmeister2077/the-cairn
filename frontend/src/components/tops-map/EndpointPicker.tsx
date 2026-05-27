import { useEffect, useMemo, useState } from "react";
import { Crosshair, Loader2, MapPin, Skull, Star, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLandmarksOverlay, useTranslocatorsOverlay } from "@/hooks/useOverlayData";
import { formatDuration } from "@/lib/format-duration";
import { computeRoutesAsync, isRouteWorkerAvailable } from "@/lib/tl-routing-client";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  setRouteFrom,
  setRoutePickMode,
  setRouteTo,
  type EndpointPick,
} from "@/store/slices/routePlanner";

/**
 * Parse user-entered coordinate strings. Accepts:
 *   - `"x, z"` / `"x z"` / `"x|z"` (2 ints)
 *   - VS `/tp x y z` (3 ints — Y is dropped, X/Z kept)
 *   - `/whereami`-style `x=…, z=…` (order-insensitive)
 *
 * Returns null on any parse failure so the caller can show an error inline
 * without throwing. Numbers may be negative; whitespace is forgiving.
 */
export function parseCoordsInput(raw: string): { x: number; z: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // `/tp x y z` — drop Y (vertical), keep X (east/west) and Z (north/south).
  const tp = trimmed.match(/^\/?tp\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/i);
  if (tp) {
    return { x: parseInt(tp[1], 10), z: parseInt(tp[3], 10) };
  }

  // Labelled: "x=123, z=-456" or "Z: -456 X: 123" — labels case-insensitive
  // and order-insensitive.
  const labelled = Array.from(trimmed.matchAll(/([xz])\s*[:=]\s*(-?\d+)/gi));
  if (labelled.length >= 2) {
    let x: number | null = null;
    let z: number | null = null;
    for (const m of labelled) {
      const axis = m[1].toLowerCase();
      const v = parseInt(m[2], 10);
      if (axis === "x" && x === null) x = v;
      else if (axis === "z" && z === null) z = v;
    }
    if (x !== null && z !== null) return { x, z };
  }

  // Plain "x, z" / "x z" / "x|z".
  const plain = trimmed.match(/^(-?\d+)\s*[,|\s]\s*(-?\d+)\s*$/);
  if (plain) {
    return { x: parseInt(plain[1], 10), z: parseInt(plain[2], 10) };
  }

  return null;
}

interface EndpointPickerProps {
  /** Which slot (from/to) this picker controls. */
  slot: "from" | "to";
  /** Visible label above the picker. */
  label: string;
}

/**
 * Compact endpoint selector used twice (From/To) inside the route planner
 * panel. Supports four input modes:
 *   1. Click on the map  — toggles `pickMode` so the next MapViewer click
 *      writes back to this slot.
 *   2. Landmark search   — Combobox driven by `useLandmarksOverlay`.
 *   3. Paste coordinates — `/tp` / labelled / "x, z" via `parseCoordsInput`.
 *   4. Favorite home     — reads `mapView.favoriteStartingPosition`.
 */
export function EndpointPicker({ slot, label }: EndpointPickerProps) {
  const dispatch = useAppDispatch();
  const value = useAppSelector((s) => (slot === "from" ? s.routePlanner.from : s.routePlanner.to));
  const pickMode = useAppSelector((s) => s.routePlanner.pickMode);
  const favorite = useAppSelector((s) => s.mapView.favoriteStartingPosition);
  const landmarks = useLandmarksOverlay();

  // "Fastest terminus" needs the TL graph inputs (segments + cost knobs) to
  // run a tiny batch of route queries against the worker. Only the `to`
  // slot actually uses these, but reading from the store unconditionally
  // keeps hook order stable across renders.
  const fromValue = useAppSelector((s) => s.routePlanner.from);
  const walkSpeed = useAppSelector((s) => s.routePlanner.walkSpeed);
  const tlPenaltySeconds = useAppSelector((s) => s.routePlanner.tlPenaltySeconds);
  const kNeighbors = useAppSelector((s) => s.routePlanner.kNeighbors);
  const translocators = useTranslocatorsOverlay();
  const segments = translocators.data?.data ?? null;
  const segmentsEtag = translocators.data?.etag ?? null;

  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);

  const [landmarkOpen, setLandmarkOpen] = useState(false);
  const [landmarkQuery, setLandmarkQuery] = useState("");
  // Terminus entries swamp the landmark list (lots of them, mostly identical
  // labels), so default the picker to "landmarks" (everything *except*
  // Terminus). Users who actually want to route to/from a Terminus can flip
  // the filter, and "all" remains available for completeness.
  const [landmarkFilter, setLandmarkFilter] = useState<"landmarks" | "terminus" | "all">(
    "landmarks",
  );

  const isPicking = pickMode === slot;

  const setSlot = (next: EndpointPick | null) => {
    dispatch(slot === "from" ? setRouteFrom(next) : setRouteTo(next));
  };

  // Build a "Label (x, z)" string for each landmark so the Combobox (which
  // works on plain strings) can both display and uniquely identify entries.
  // Unnamed landmarks fall back to "<Kind> @ x,z". When the user is browsing
  // "all", Terminus rows are prefixed with `[Terminus] ` so they're easy to
  // tell apart from regular landmarks that happen to share the same name.
  const landmarkSuggestions = useMemo(() => {
    const data = landmarks.data?.data ?? [];
    const filtered = data.filter((lm) => {
      const isTerminus = lm.kind === "Terminus";
      if (landmarkFilter === "landmarks") return !isTerminus;
      if (landmarkFilter === "terminus") return isTerminus;
      return true;
    });
    return filtered
      .map((lm) => {
        const name = lm.label?.trim() || `${lm.kind ?? "Point"} @ ${lm.x},${lm.z}`;
        const prefix = landmarkFilter === "all" && lm.kind === "Terminus" ? "[Terminus] " : "";
        return `${prefix}${name} (${lm.x}, ${lm.z})`;
      })
      .sort((a, b) => a.localeCompare(b));
  }, [landmarks.data, landmarkFilter]);

  const handleLandmarkSelect = (entry: string) => {
    // Extract trailing "(x, z)" — robust against names that contain
    // parentheses by always matching the LAST pair.
    const m = entry.match(/\((-?\d+)\s*,\s*(-?\d+)\)\s*$/);
    if (!m) return;
    const x = parseInt(m[1], 10);
    const z = parseInt(m[2], 10);
    // Strip the optional "[Terminus] " visual prefix before storing the label
    // so saved/shared endpoints don't carry UI decoration into the chip.
    const rawName = entry.slice(0, entry.lastIndexOf("(")).trim();
    const name = rawName.replace(/^\[Terminus\]\s*/, "");
    setSlot({ point: { x, z }, label: name, source: "landmark" });
    setLandmarkOpen(false);
    setLandmarkQuery("");
  };

  const handlePasteApply = () => {
    const parsed = parseCoordsInput(pasteText);
    if (!parsed) {
      setPasteError("Couldn't parse — try `123, -456`, `/tp 123 110 -456`, or `x=123 z=-456`.");
      return;
    }
    setSlot({
      point: parsed,
      label: `${parsed.x}, ${parsed.z}`,
      source: "paste",
    });
    setPasteOpen(false);
    setPasteText("");
    setPasteError(null);
  };

  const handleUseFavorite = () => {
    if (!favorite) return;
    setSlot({
      point: { x: favorite.x, z: favorite.z },
      label: "Favorite home",
      source: "favorite",
    });
  };

  // "Fastest terminus" — given the current `from` endpoint, find the
  // Terminus reachable fastest via the TL graph and write it into `to`.
  // The intended use case is "I just respawned; route me back to my last
  // death location" since Terminus markers represent death-return TLs.
  //
  // We pre-filter to the K Euclidean-closest terminuses to bound how many
  // worker queries we fire. The graph is cached inside the worker, so the
  // first call pays the build cost and the rest are cheap A* runs.
  const [fastestState, setFastestState] = useState<"idle" | "computing" | "error">("idle");
  const [fastestError, setFastestError] = useState<string | null>(null);
  // Cache of all reachable Terminuses from the last `From` we ran against.
  // First entry is the winner (auto-applied to `To`); the rest are shown as
  // swap chips with their +Δs vs the winner so users can trade a few
  // seconds for a Terminus closer to where they actually died.
  interface FastestCandidate {
    label: string;
    point: { x: number; z: number };
    totalSeconds: number;
  }
  const [fastestResults, setFastestResults] = useState<FastestCandidate[]>([]);
  // Stable key for the `from` point this batch was computed against — when
  // `from` changes (or is cleared) we drop the stale alternatives so the
  // chips never refer to a different starting situation.
  const [fastestSourceKey, setFastestSourceKey] = useState<string | null>(null);
  const FASTEST_CANDIDATES = 12;
  const FASTEST_MAX_ALTS = 4;

  const fromKey = fromValue ? `${fromValue.point.x},${fromValue.point.z}` : null;
  useEffect(() => {
    if (fromKey !== fastestSourceKey) {
      setFastestResults([]);
      setFastestError(null);
      if (fastestState === "error") setFastestState("idle");
    }
    // We intentionally do NOT depend on `fastestSourceKey` to avoid an
    // immediate self-reset loop right after a successful batch sets it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromKey]);

  async function handleFindFastestTerminus() {
    if (!fromValue || !segments) return;
    const data = landmarks.data?.data ?? [];
    const terminuses = data.filter((lm) => lm.kind === "Terminus");
    if (terminuses.length === 0) {
      setFastestState("error");
      setFastestError("No Terminus markers found on this map.");
      return;
    }
    const startPt = fromValue.point;
    const candidates = terminuses
      .map((t) => ({
        t,
        d2: (t.x - startPt.x) ** 2 + (t.z - startPt.z) ** 2,
      }))
      .sort((a, b) => a.d2 - b.d2)
      .slice(0, FASTEST_CANDIDATES)
      .map((c) => c.t);

    setFastestState("computing");
    setFastestError(null);
    try {
      if (!isRouteWorkerAvailable()) {
        throw new Error("Routing worker is unavailable in this browser.");
      }
      const key = segmentsEtag ?? `len:${segments.length}`;
      const opts = { walkSpeed, tlPenaltySeconds, kNeighbors };
      // Issue all queries in parallel. The worker serialises them internally
      // but reuses the cached graph across calls, so the wall time is
      // roughly (graph-build + K * A*).
      const settled = await Promise.all(
        candidates.map((t) =>
          computeRoutesAsync({
            segments,
            segmentsKey: key,
            from: startPt,
            to: { x: t.x, z: t.z },
            opts,
            numberOfRoutes: 1,
          })
            .then((r) => ({ t, route: r.routes[0] ?? null }))
            .catch(() => ({ t, route: null })),
        ),
      );
      const reachable = settled.filter(
        (r): r is { t: (typeof candidates)[number]; route: NonNullable<typeof r.route> } =>
          r.route !== null,
      );
      // TEMP debug logging to diagnose "wrong terminus wins" reports.
      // Remove once the routing-selection logic is verified end-to-end.
      // eslint-disable-next-line no-console
      console.debug(
        "[fastest-terminus] start",
        startPt,
        "candidates",
        candidates.map((c) => ({ x: c.x, z: c.z, label: c.label })),
      );
      // eslint-disable-next-line no-console
      console.debug(
        "[fastest-terminus] results",
        settled.map((s) => ({
          x: s.t.x,
          z: s.t.z,
          label: s.t.label,
          seconds: s.route?.totalSeconds ?? null,
          tlHops: s.route?.tlHops ?? null,
          walkBlocks: s.route?.walkBlocks ?? null,
        })),
      );
      if (reachable.length === 0) {
        setFastestState("error");
        setFastestError("Couldn't reach any nearby Terminus from the current start.");
        return;
      }
      reachable.sort((a, b) => a.route.totalSeconds - b.route.totalSeconds);
      const enriched: FastestCandidate[] = reachable.map((r) => ({
        label: r.t.label?.trim() || `Terminus @ ${r.t.x},${r.t.z}`,
        point: { x: r.t.x, z: r.t.z },
        totalSeconds: r.route.totalSeconds,
      }));
      const winner = enriched[0];
      setSlot({ point: winner.point, label: winner.label, source: "landmark" });
      setFastestResults(enriched);
      setFastestSourceKey(fromKey);
      setFastestState("idle");
    } catch (err) {
      setFastestState("error");
      setFastestError(err instanceof Error ? err.message : "Couldn't compute fastest terminus.");
    }
  }

  const togglePickMode = () => {
    dispatch(setRoutePickMode(isPicking ? null : slot));
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </Label>
        {value && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-xs"
            onClick={() => setSlot(null)}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>

      {/* Current value chip — colored by source so the user can tell at a
          glance how the endpoint was set (especially useful when the value
          came from a URL share). */}
      <div className="rounded-md border bg-muted/30 px-2 py-1.5 text-xs">
        {value ? (
          <div className="flex items-center gap-2">
            <MapPin className="h-3 w-3 shrink-0 text-emerald-600" />
            <div className="min-w-0 flex-1 truncate">
              <span className="font-medium">{value.label ?? "Picked point"}</span>
              <span className="ml-1 text-muted-foreground">
                ({value.point.x}, {value.point.z})
              </span>
            </div>
            <span className="shrink-0 rounded bg-background px-1 text-[10px] text-muted-foreground">
              {value.source}
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground">Not set</span>
        )}
      </div>

      {/* Action row — pick on map / landmark / paste / favorite. Sized to
          stay readable in narrow drawer widths down to ~280px. */}
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          variant={isPicking ? "default" : "outline"}
          className="h-7 flex-1 gap-1 px-2 text-xs flex-1"
          onClick={togglePickMode}
        >
          <Crosshair className="h-3 w-3" />
          {isPicking ? "Click map…" : "Pick on map"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs flex-1"
          onClick={() => setLandmarkOpen((v) => !v)}
        >
          <MapPin className="h-3 w-3" /> Landmark
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs flex-1"
          onClick={() => setPasteOpen((v) => !v)}
        >
          Paste
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs flex-1"
          disabled={!favorite}
          onClick={handleUseFavorite}
          title={favorite ? "Use favorite home" : "No favorite home set"}
        >
          <Star className="h-3 w-3" /> Home
        </Button>
      </div>

      {/* Shortcut for the post-respawn flow: with `From` set (e.g. the
          player's bed/spawn), one click finds the Terminus reachable
          fastest by the TL graph and writes it into `To`. Only offered
          on the destination slot. */}
      {slot === "to" && (
        <>
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-full gap-1 px-2 text-xs"
            disabled={!fromValue || !segments || fastestState === "computing"}
            onClick={handleFindFastestTerminus}
            title={
              !fromValue
                ? "Set From first to find the fastest Terminus from there"
                : !segments
                  ? "Loading translocator graph…"
                  : "Find the Terminus reachable fastest from From"
            }
          >
            {fastestState === "computing" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Skull className="h-3 w-3" />
            )}
            Fastest terminus from start
          </Button>
          {fastestError && fastestState === "error" && (
            <p className="text-[11px] text-red-600">{fastestError}</p>
          )}
          {/* Alternative terminuses, sorted by +Δ vs the winner. Yen's
              alternates in the route planner only swap *paths*, never the
              destination — so we surface other reachable Terminuses here
              and let the user trade a few seconds for one closer to where
              they actually died. Clicking a chip swaps `To`; the route
              planner recomputes automatically. */}
          {fastestResults.length > 1 && fastestSourceKey === fromKey && (
            <div className="space-y-1 rounded-md border bg-muted/30 p-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Other reachable terminuses
              </p>
              <div className="flex flex-wrap gap-1">
                {fastestResults.slice(1, 1 + FASTEST_MAX_ALTS).map((alt) => {
                  const delta = alt.totalSeconds - fastestResults[0].totalSeconds;
                  const isSelected =
                    value?.point.x === alt.point.x && value?.point.z === alt.point.z;
                  return (
                    <Button
                      key={`${alt.point.x},${alt.point.z}`}
                      type="button"
                      size="sm"
                      variant={isSelected ? "default" : "outline"}
                      className="h-6 max-w-full gap-1 px-2 text-[11px]"
                      title={`Total ${formatDuration(alt.totalSeconds)} (+${formatDuration(delta)} vs fastest)`}
                      onClick={() =>
                        setSlot({
                          point: alt.point,
                          label: alt.label,
                          source: "landmark",
                        })
                      }
                    >
                      <span className="truncate">{alt.label}</span>
                      <span className="shrink-0 text-muted-foreground">
                        +{formatDuration(delta)}
                      </span>
                    </Button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {landmarkOpen && (
        <div className="space-y-1.5 rounded-md border bg-background p-2">
          {/* Tiny segmented filter — Terminus markers tend to share labels
              and outnumber regular landmarks, so let the user narrow the
              search before the Combobox starts matching. */}
          <div className="flex gap-1" role="group" aria-label="Filter landmark suggestions">
            {(
              [
                { key: "landmarks", label: "Landmarks" },
                { key: "terminus", label: "Terminuses" },
                { key: "all", label: "All" },
              ] as const
            ).map((opt) => (
              <Button
                key={opt.key}
                type="button"
                size="sm"
                variant={landmarkFilter === opt.key ? "default" : "outline"}
                className="h-6 flex-1 px-2 text-[11px]"
                onClick={() => setLandmarkFilter(opt.key)}
                aria-pressed={landmarkFilter === opt.key}
              >
                {opt.label}
              </Button>
            ))}
          </div>
          <Combobox
            value={landmarkQuery}
            onChange={setLandmarkQuery}
            onSelect={handleLandmarkSelect}
            suggestions={landmarkSuggestions}
            placeholder={
              landmarks.isLoading
                ? "Loading landmarks…"
                : landmarkFilter === "terminus"
                  ? "Search terminuses…"
                  : "Search landmarks…"
            }
          />
        </div>
      )}

      {pasteOpen && (
        <div className="space-y-1.5 rounded-md border bg-background p-2">
          <Input
            value={pasteText}
            onChange={(e) => {
              setPasteText(e.target.value);
              setPasteError(null);
            }}
            placeholder="e.g. 1234, -5678  or  /tp 1234 110 -5678"
            onKeyDown={(e) => {
              if (e.key === "Enter") handlePasteApply();
            }}
            autoFocus
            className="h-7 text-xs"
          />
          {pasteError && <p className="text-xs text-red-600">{pasteError}</p>}
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => {
                setPasteOpen(false);
                setPasteText("");
                setPasteError(null);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" className="h-6 px-2 text-xs" onClick={handlePasteApply}>
              Apply
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

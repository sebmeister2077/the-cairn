import { useMemo, useState } from "react";
import { Crosshair, MapPin, Star, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLandmarksOverlay } from "@/hooks/useOverlayData";
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

  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);

  const [landmarkOpen, setLandmarkOpen] = useState(false);
  const [landmarkQuery, setLandmarkQuery] = useState("");

  const isPicking = pickMode === slot;

  const setSlot = (next: EndpointPick | null) => {
    dispatch(slot === "from" ? setRouteFrom(next) : setRouteTo(next));
  };

  // Build a "Label (x, z)" string for each landmark so the Combobox (which
  // works on plain strings) can both display and uniquely identify entries.
  // Unnamed landmarks fall back to "<Kind> @ x,z".
  const landmarkSuggestions = useMemo(() => {
    const data = landmarks.data?.data ?? [];
    return data
      .map((lm) => {
        const name = lm.label?.trim() || `${lm.kind ?? "Point"} @ ${lm.x},${lm.z}`;
        return `${name} (${lm.x}, ${lm.z})`;
      })
      .sort((a, b) => a.localeCompare(b));
  }, [landmarks.data]);

  const handleLandmarkSelect = (entry: string) => {
    // Extract trailing "(x, z)" — robust against names that contain
    // parentheses by always matching the LAST pair.
    const m = entry.match(/\((-?\d+)\s*,\s*(-?\d+)\)\s*$/);
    if (!m) return;
    const x = parseInt(m[1], 10);
    const z = parseInt(m[2], 10);
    const name = entry.slice(0, entry.lastIndexOf("(")).trim();
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

      {landmarkOpen && (
        <div className="rounded-md border bg-background p-2">
          <Combobox
            value={landmarkQuery}
            onChange={setLandmarkQuery}
            onSelect={handleLandmarkSelect}
            suggestions={landmarkSuggestions}
            placeholder={landmarks.isLoading ? "Loading landmarks…" : "Search landmarks…"}
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

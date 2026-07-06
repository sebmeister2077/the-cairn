// Location picker for the Orders marketplace. Lets a trader set a pickup /
// meeting location three ways (mirrors the route-planner EndpointPicker):
//   1. Landmark search — Combobox driven by `useLandmarksOverlay`.
//   2. Favorite home   — reads `mapView.favoriteStartingPosition`.
//   3. Manual coords   — `/tp` / labelled / "x, z" via `parseCoordsInput`.

import { useMemo, useState } from "react";
import { MapPin, Star, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLandmarksOverlay } from "@/hooks/useOverlayData";
import { useAppSelector } from "@/store/hooks";
import { parseCoordsInput } from "@/components/tops-map/EndpointPicker";
import type { OrderLocation } from "@/models/orders";

interface TraderLocationFieldProps {
  value: OrderLocation | null;
  onChange: (loc: OrderLocation | null) => void;
}

export function TraderLocationField({ value, onChange }: TraderLocationFieldProps) {
  const favorite = useAppSelector((s) => s.mapView.favoriteStartingPosition);
  const landmarks = useLandmarksOverlay();

  const [landmarkQuery, setLandmarkQuery] = useState("");
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);

  const landmarkSuggestions = useMemo(() => {
    const data = landmarks.data?.data ?? [];
    return data
      .filter((lm) => lm.kind !== "Terminus")
      .map((lm) => {
        const name = lm.label?.trim() || `${lm.kind ?? "Point"} @ ${lm.x},${lm.z}`;
        return `${name} (${lm.x}, ${lm.z})`;
      })
      .sort((a, b) => a.localeCompare(b));
  }, [landmarks.data]);

  const handleLandmarkSelect = (entry: string) => {
    const m = entry.match(/\((-?\d+)\s*,\s*(-?\d+)\)\s*$/);
    if (!m) return;
    const x = parseInt(m[1], 10);
    const z = parseInt(m[2], 10);
    const label = entry.slice(0, entry.lastIndexOf("(")).trim();
    onChange({ source: "landmark", x, z, label });
    setLandmarkQuery("");
  };

  const handleUseFavorite = () => {
    if (!favorite) return;
    onChange({ source: "favorite", x: favorite.x, z: favorite.z, label: "Favorite home" });
  };

  const handleManualApply = () => {
    const parsed = parseCoordsInput(manual);
    if (!parsed) {
      setManualError('Enter coordinates like "1234, -567"');
      return;
    }
    onChange({ source: "manual", x: parsed.x, z: parsed.z, label: `${parsed.x}, ${parsed.z}` });
    setManual("");
    setManualError(null);
  };

  return (
    <div className="space-y-2">
      <Label>Location (optional)</Label>
      {value ? (
        <div className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
          <MapPin className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="flex-1 truncate">
            {value.label || `${value.x}, ${value.z}`}
            <span className="ml-1 text-muted-foreground">
              ({value.x}, {value.z})
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onChange(null)}
            aria-label="Clear location"
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Combobox
            value={landmarkQuery}
            onChange={setLandmarkQuery}
            onSelect={handleLandmarkSelect}
            suggestions={landmarkSuggestions}
            placeholder="Search a landmark…"
          />
          <div className="flex items-center gap-2">
            <Input
              value={manual}
              onChange={(e) => {
                setManual(e.target.value);
                setManualError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleManualApply();
                }
              }}
              placeholder="Or paste coords: 1234, -567"
              className="h-9"
            />
            <Button type="button" variant="outline" size="sm" onClick={handleManualApply}>
              Set
            </Button>
            {favorite && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleUseFavorite}
                title="Use your favorite home position"
              >
                <Star className="h-4 w-4" aria-hidden />
              </Button>
            )}
          </div>
          {manualError && <p className="text-xs text-destructive">{manualError}</p>}
        </div>
      )}
    </div>
  );
}

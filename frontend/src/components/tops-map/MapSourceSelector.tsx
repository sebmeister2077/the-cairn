import { useState } from "react";
import { Globe, MapPinned } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppDispatch, useReduxState } from "@/store/hooks";
import {
  DEFAULT_WEBCARTOGRAPHER_URL,
  WEBCARTOGRAPHER_PRESETS,
  setMapSource,
  setWebCartographerUrl,
  type MapSource,
} from "@/store/slices/mapView";
import { cn } from "@/lib/utils";

interface MapSourceSelectorProps {
  /** Optional className applied to the wrapping container. */
  className?: string;
  /** Compact mode hides the help copy. Used inside the fullscreen overlay. */
  compact?: boolean;
}

/**
 * Source picker for the TOPS map viewer.
 *
 * Lets the user choose between our own ("cairn") pre-rendered tiles and an
 * external WebCartographer-style host (such as
 * https://tops-map.translocator.moe). When the WebCartographer source is
 * picked the URL is editable, with one-click presets for the publicly known
 * hosts. All overlays (TLs, traders, landmarks, oceans) keep coming from
 * our database — only the base map imagery swaps.
 *
 * State lives on the `mapView` slice so the choice persists across reloads.
 */
export function MapSourceSelector({ className, compact = false }: MapSourceSelectorProps) {
  const dispatch = useAppDispatch();
  const mapSource = useReduxState("mapView.mapSource");
  const storedUrl = useReduxState("mapView.webCartographerUrl");

  // Local draft so the URL Input can be typed into freely without each
  // keystroke triggering a Redux dispatch + re-render cascade. Committed
  // on blur / Enter / preset selection.
  const [draftUrl, setDraftUrl] = useState(storedUrl);

  const commitUrl = (next: string) => {
    const trimmed = next.trim();
    const effective = trimmed.length > 0 ? trimmed : DEFAULT_WEBCARTOGRAPHER_URL;
    setDraftUrl(effective);
    if (effective !== storedUrl) dispatch(setWebCartographerUrl(effective));
  };

  const handleSourceChange = (next: MapSource) => {
    if (next !== mapSource) dispatch(setMapSource(next));
  };

  const matchingPreset = WEBCARTOGRAPHER_PRESETS.find((p) => p.url === storedUrl)?.url ?? "";

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <Tabs value={mapSource} onValueChange={(v) => handleSourceChange(v as MapSource)}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger
            value="cairn"
            disabled
            className="flex items-center gap-1.5"
            title="Cairn map is temporarily disabled"
          >
            <MapPinned className="size-3.5" />
            Cairn map
          </TabsTrigger>
          <TabsTrigger value="webcartographer" className="flex items-center gap-1.5">
            <Globe className="size-3.5" />
            WebCartographer
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {mapSource === "webcartographer" && (
        <div className="flex flex-col gap-2">
          {!compact && (
            <p className="text-xs text-muted-foreground">
              External tile imagery from a WebCartographer-hosted map. Our translocators, traders,
              landmarks, and ocean overlay are still drawn on top.
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wc-preset" className="text-xs">
              Preset host
            </Label>
            <Select
              value={matchingPreset}
              onValueChange={(url) => {
                if (!url) return;
                commitUrl(url);
              }}
            >
              <SelectTrigger id="wc-preset" className="h-8">
                <SelectValue placeholder="Choose a known host…" />
              </SelectTrigger>
              <SelectContent>
                {WEBCARTOGRAPHER_PRESETS.map((p) => (
                  <SelectItem key={p.url} value={p.url} disabled={p.disabled}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wc-url" className="text-xs">
              Host URL
            </Label>
            <div className="flex gap-2">
              <Input
                id="wc-url"
                value={draftUrl}
                onChange={(e) => setDraftUrl(e.target.value)}
                onBlur={() => commitUrl(draftUrl)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
                placeholder="https://tops-map.translocator.moe"
                spellCheck={false}
                autoComplete="off"
                className="h-8 font-mono text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => commitUrl(draftUrl)}
                disabled={draftUrl.trim() === storedUrl}
              >
                Apply
              </Button>
            </div>
            {!compact && (
              <p className="text-[11px] text-muted-foreground">
                Tiles are loaded directly from <code>{storedUrl}</code>
                <span className="font-mono">
                  /data/world/&#123;z&#125;/&#123;x&#125;_&#123;y&#125;.png
                </span>
                .
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

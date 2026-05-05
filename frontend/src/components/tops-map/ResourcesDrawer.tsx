import { useMemo } from "react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { ResourcesOverlayState } from "@/hooks/useResourcesOverlay";
import { Slider } from "../ui/slider";

interface ResourcesDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ResourcesOverlayState;
}

export function ResourcesDrawer({ open, onOpenChange, state }: ResourcesDrawerProps) {
  const {
    manifest,
    layerIds,
    activeLayers,
    toggleLayer,
    opacity,
    setOpacity,
    depositsVisible,
    setDepositsVisible,
    depositTypeVisibility,
    toggleDepositType,
    setAllDepositTypes,
    reset,
    deposits,
    depositsLoading,
  } = state;

  const layersById = useMemo(() => {
    const map = new Map<string, NonNullable<typeof manifest>["layers"][number]>();
    if (manifest) for (const l of manifest.layers) map.set(l.id, l);
    return map;
  }, [manifest]);

  const depositTypes = manifest?.deposit_types ?? [];
  const visibleTypeCount = depositTypes.filter((t) => depositTypeVisibility[t.id]).length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Resources overlay</SheetTitle>
          <SheetDescription>
            Worldgen-derived heatmaps and ore deposits reconstructed from the canonical world seed.
          </SheetDescription>
        </SheetHeader>

        {!manifest && (
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No resources bundle is currently active. Upload one from the admin
            <span className="font-mono"> /manage/resources </span>
            page.
          </div>
        )}

        {manifest && (
          <div className="flex-1 overflow-y-auto -mx-4 px-4 flex flex-col gap-5">
            {/* Heatmap layers */}
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Heatmap layers
                </Label>
              </div>
              {layerIds.length === 0 && (
                <p className="text-xs text-muted-foreground">No heatmap layers in this bundle.</p>
              )}
              <ul className="flex flex-col gap-1.5">
                {layerIds.map((id) => {
                  const layer = layersById.get(id);
                  const checked = !!activeLayers[id];
                  return (
                    <li
                      key={id}
                      className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm transition-colors ${
                        checked ? "border-primary bg-primary/5" : ""
                      }`}
                    >
                      <Checkbox
                        className="cursor-pointer"
                        checked={checked}
                        onCheckedChange={() => toggleLayer(id)}
                        aria-label={`Toggle ${id} heatmap`}
                      />
                      <span className="flex-1 capitalize">{id}</span>
                      {layer?.scale && (
                        <span className="text-[11px] text-muted-foreground">
                          {layer.scale.min}
                          {layer.scale.unit ? ` ${layer.scale.unit}` : ""}
                          {" \u2192 "}
                          {layer.scale.max}
                          {layer.scale.unit ? ` ${layer.scale.unit}` : ""}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>

              <div className="mt-2 flex flex-col gap-1">
                <Label htmlFor="resources-opacity" className="text-xs">
                  Opacity ({Math.round(opacity * 100)}%)
                </Label>
                <Slider
                  value={Math.round(opacity * 100)}
                  min={0}
                  max={100}
                  onValueChange={(val) => setOpacity(val / 100)}
                />
              </div>
            </section>

            {/* Deposits */}
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Ore deposits
                </Label>
                <span className="text-[11px] text-muted-foreground">
                  {depositsLoading ? "Loading\u2026" : `${deposits.length.toLocaleString()} shown`}
                </span>
              </div>
              <div className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
                <Switch
                  checked={depositsVisible}
                  onCheckedChange={setDepositsVisible}
                  aria-label="Show ore deposits"
                />
                <Label>Show deposits</Label>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setAllDepositTypes(true)}
                >
                  Select all
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setAllDepositTypes(false)}
                >
                  Clear
                </Button>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {visibleTypeCount} / {depositTypes.length} types
                </span>
              </div>

              <ul className="flex flex-col gap-1 max-h-[40vh] overflow-y-auto rounded-md border p-1">
                {depositTypes.length === 0 && (
                  <li className="px-2 py-1 text-xs text-muted-foreground">
                    No deposit types in manifest.
                  </li>
                )}
                {depositTypes.map((t) => {
                  const checked = depositTypeVisibility[t.id] !== false;
                  return (
                    <li
                      key={t.id}
                      className="flex items-center gap-2 rounded px-1.5 py-0.5 text-sm hover:bg-muted/60"
                    >
                      <Checkbox
                        className="cursor-pointer"
                        checked={checked}
                        onCheckedChange={() => toggleDepositType(t.id)}
                        aria-label={`Toggle ${t.label}`}
                      />
                      <span
                        className="inline-block h-3 w-3 rounded-sm border border-black/30"
                        style={{ backgroundColor: t.color }}
                        aria-hidden
                      />
                      <span className="flex-1 truncate" title={t.id}>
                        {t.label}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button type="button" size="sm" variant="outline" onClick={reset}>
                Reset
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

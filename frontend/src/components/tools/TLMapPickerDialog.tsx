// Endpoint picker dialog for the tunnel tool. Two ways to pick:
//   1. Search the landmark overlay (Translocators, bases, traders…)
//   2. Type X / Y / Z manually
//
// Decoupled from the route-planner Redux store so it can be reused
// outside that flow. Returns the chosen coord + optional label.
//
// Landmarks have no Y coord — we use the caller-provided `defaultY`
// (typically the Y of the previous endpoint) as a fallback. The user
// can edit Y in the dialog before applying.

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLandmarksOverlay } from "@/hooks/useOverlayData";
import { useTranslation } from "@/lib/i18n";
import type { Block3 } from "@/lib/tunnel-share";

import { IntegerField } from "./IntegerField";

interface TLMapPickerDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  defaultY: number;
  onPick: (coord: Block3, label?: string) => void;
}

type LandmarkFilter = "translocator" | "landmark" | "all";

export function TLMapPickerDialog({
  open,
  onOpenChange,
  defaultY,
  onPick,
}: TLMapPickerDialogProps) {
  const { t } = useTranslation();
  const landmarks = useLandmarksOverlay();

  const [filter, setFilter] = useState<LandmarkFilter>("translocator");
  const [search, setSearch] = useState("");
  const [coord, setCoord] = useState<Block3>({ x: 0, y: defaultY, z: 0 });
  const [label, setLabel] = useState<string>("");

  // Reset transient state every time the dialog opens.
  useEffect(() => {
    if (open) {
      setSearch("");
      setLabel("");
      setCoord({ x: 0, y: defaultY, z: 0 });
    }
  }, [open, defaultY]);

  const suggestions = useMemo(() => {
    const data = landmarks.data?.data ?? [];
    const filtered = data.filter((lm) => {
      const isTerminus = lm.kind === "Terminus";
      if (filter === "translocator") return isTerminus;
      if (filter === "landmark") return !isTerminus;
      return true;
    });
    return filtered
      .map((lm) => {
        const name = lm.label?.trim() || `${lm.kind ?? "Point"} @ ${lm.x},${lm.z}`;
        const prefix = filter === "all" && lm.kind === "Terminus" ? "[Terminus] " : "";
        return `${prefix}${name} (${lm.x}, ${lm.z})`;
      })
      .sort((a, b) => a.localeCompare(b));
  }, [landmarks.data, filter]);

  const handleLandmarkPick = (entry: string) => {
    const m = entry.match(/\((-?\d+)\s*,\s*(-?\d+)\)\s*$/);
    if (!m) return;
    const x = parseInt(m[1], 10);
    const z = parseInt(m[2], 10);
    const rawName = entry.slice(0, entry.lastIndexOf("(")).trim();
    const name = rawName.replace(/^\[Terminus\]\s*/, "");
    setCoord({ x, y: defaultY, z });
    setLabel(name);
    setSearch(entry);
  };

  const handleApply = () => {
    onPick(coord, label.trim() || undefined);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("tools.tunnel.pickerTitle")}</DialogTitle>
          <DialogDescription>{t("tools.tunnel.pickerDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {t("tools.tunnel.pickerFilterLabel")}
            </Label>
            <Select value={filter} onValueChange={(v) => setFilter(v as LandmarkFilter)}>
              <SelectTrigger size="sm">
                <SelectValue>{t(`tools.tunnel.pickerFilters.${filter}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="translocator">
                  {t("tools.tunnel.pickerFilters.translocator")}
                </SelectItem>
                <SelectItem value="landmark">{t("tools.tunnel.pickerFilters.landmark")}</SelectItem>
                <SelectItem value="all">{t("tools.tunnel.pickerFilters.all")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {t("tools.tunnel.pickerSearchLabel")}
            </Label>
            <Combobox
              value={search}
              onChange={setSearch}
              onSelect={handleLandmarkPick}
              suggestions={suggestions}
              placeholder={t("tools.tunnel.pickerSearchPlaceholder")}
            />
            {landmarks.isLoading && (
              <p className="text-[10px] text-muted-foreground">{t("tools.tunnel.pickerLoading")}</p>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {t("tools.tunnel.pickerCoordsLabel")}
            </Label>
            <div className="grid grid-cols-3 gap-2">
              <IntegerField
                id="picker-x"
                label={t("tools.tunnel.x")}
                value={coord.x}
                onChange={(x) => setCoord((c) => ({ ...c, x }))}
              />
              <IntegerField
                id="picker-y"
                label={t("tools.tunnel.y")}
                value={coord.y}
                onChange={(y) => setCoord((c) => ({ ...c, y }))}
              />
              <IntegerField
                id="picker-z"
                label={t("tools.tunnel.z")}
                value={coord.z}
                onChange={(z) => setCoord((c) => ({ ...c, z }))}
              />
            </div>
            <p className="text-[10px] text-muted-foreground">{t("tools.tunnel.pickerYHint")}</p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("tools.tunnel.pickerCancel")}
          </Button>
          <Button type="button" onClick={handleApply}>
            {t("tools.tunnel.pickerApply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import type { TopsMapResolutionMeta } from "@/lib/api";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

export function ResolutionSelector({
  selectedLevel,
  resolutionLevels,
  setSelectedLevel,
}: {
  selectedLevel: number | null;
  setSelectedLevel: (res: number) => void;
  resolutionLevels: TopsMapResolutionMeta[] | undefined;
}) {
  if (selectedLevel == null) return null;

  return (
    <div className="ml-auto flex items-center gap-2">
      <Label htmlFor="tops-map-resolution" className="text-xs text-muted-foreground">
        Resolution
      </Label>
      <Select value={String(selectedLevel)} onValueChange={(v) => setSelectedLevel(Number(v))}>
        <SelectTrigger id="tops-map-resolution" className="h-8 w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(resolutionLevels ?? []).map((r) => (
            <SelectItem key={r.level} value={String(r.level)} disabled={r.status !== "complete"}>
              L{r.level} ·{" "}
              {r.level === 5 ? "Native 1:1 (10× L4)" : `${r.max_dimension.toLocaleString()} px`}
              {r.status !== "complete" ? ` · ${r.status}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

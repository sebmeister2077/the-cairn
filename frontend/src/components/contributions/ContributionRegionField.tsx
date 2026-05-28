/**
 * Phase 2 / Phase D — contributor-side region picker wrapper.
 *
 * Wraps the raw {@link ContributionRegionPicker} with a two-mode toggle and
 * snaps the picker output to 32-block chunk boundaries so the contributor
 * always submits whole chunks. Kept in its own file so the upload card
 * stays small.
 */

import { useEffect } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "@/lib/i18n";
import { ContributionRegionPicker } from "../ContributionRegionPicker";
import type { ContributeInfo } from "@/models/contributions";
import type { ContributionRegion, TopsMapResolutionMeta } from "@/lib/api";

export type ContributionMode = "gap_fill" | "overwrite";

const TILE_SIZE = 32;

/**
 * Snap an arbitrary block-coordinate rectangle to whole chunks (32-block
 * grid). `min` snaps down to the chunk boundary, `max` snaps up to the
 * last block of the chunk it lies in. Guarantees a non-empty whole-chunk
 * region as long as the source rectangle had any extent.
 */
export function snapRegionToChunks(r: ContributionRegion): ContributionRegion {
  const min_tx = Math.floor(r.min_x / TILE_SIZE);
  const max_tx = Math.floor(r.max_x / TILE_SIZE);
  const min_tz = Math.floor(r.min_z / TILE_SIZE);
  const max_tz = Math.floor(r.max_z / TILE_SIZE);
  return {
    min_x: min_tx * TILE_SIZE,
    max_x: (max_tx + 1) * TILE_SIZE - 1,
    min_z: min_tz * TILE_SIZE,
    max_z: (max_tz + 1) * TILE_SIZE - 1,
  };
}

export function regionChunkArea(r: ContributionRegion): number {
  const min_tx = Math.floor(r.min_x / TILE_SIZE);
  const max_tx = Math.floor(r.max_x / TILE_SIZE);
  const min_tz = Math.floor(r.min_z / TILE_SIZE);
  const max_tz = Math.floor(r.max_z / TILE_SIZE);
  return Math.max(0, max_tx - min_tx + 1) * Math.max(0, max_tz - min_tz + 1);
}

/**
 * Whether the current (mode, region) selection is acceptable for upload.
 * - `gap_fill` is always valid (legacy behaviour).
 * - `overwrite` requires a non-null region with at least one chunk and,
 *   for non-admin contributors, an area within the configured cap.
 */
export function isRegionSelectionValid(
  mode: ContributionMode,
  region: ContributionRegion | null,
  cap: number | null,
): boolean {
  if (mode === "gap_fill") return true;
  if (!region) return false;
  const area = regionChunkArea(region);
  if (area < 1) return false;
  if (cap != null && area > cap) return false;
  return true;
}

interface Props {
  info: ContributeInfo | null;
  isAdmin: boolean;
  availableLevels: TopsMapResolutionMeta[];
  mode: ContributionMode;
  onModeChange: (mode: ContributionMode) => void;
  region: ContributionRegion | null;
  onRegionChange: (region: ContributionRegion | null) => void;
  disabled?: boolean;
}

export function ContributionRegionField({
  info,
  isAdmin,
  availableLevels,
  mode,
  onModeChange,
  region,
  onRegionChange,
  disabled = false,
}: Props) {
  const { t } = useTranslation();
  // Backend exposes `region_chunk_area_cap_non_admin` (new name) plus the
  // legacy `region_tile_cap_non_admin` alias for one release. Prefer the
  // new field but fall back to the alias.
  const infoAny = info as (ContributeInfo & { region_chunk_area_cap_non_admin?: number }) | null;
  const cap = isAdmin
    ? null
    : (infoAny?.region_chunk_area_cap_non_admin ?? infoAny?.region_tile_cap_non_admin ?? null);

  // Clear the region when the user switches back to gap-fill so a stale
  // selection isn't accidentally submitted.
  useEffect(() => {
    if (mode === "gap_fill" && region) onRegionChange(null);
  }, [mode, region, onRegionChange]);

  const handleRegionChange = (next: ContributionRegion | null) => {
    if (!next) {
      onRegionChange(null);
      return;
    }
    onRegionChange(snapRegionToChunks(next));
  };

  const area = region ? regionChunkArea(region) : 0;
  const overCap = cap != null && area > cap;

  return (
    <div className="space-y-3 rounded border p-3">
      <div className="flex items-center justify-between gap-2">
        <Label className="m-0">{t("contributePage.regionField.title")}</Label>
        {isAdmin && <Badge variant="outline">{t("contributePage.regionField.adminBadge")}</Badge>}
      </div>

      <Tabs value={mode} onValueChange={(v) => onModeChange(v as ContributionMode)}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="gap_fill" disabled={disabled}>
            {t("contributePage.regionField.addNewAreas")}
          </TabsTrigger>
          <TabsTrigger value="overwrite" disabled={disabled}>
            {t("contributePage.regionField.updateExistingRegion")}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === "gap_fill" && (
        <p className="text-xs text-muted-foreground">
          {t("contributePage.regionField.gapFillDescription")}
        </p>
      )}

      {mode === "overwrite" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t("contributePage.regionField.overwriteDescription")}
          </p>
          <ContributionRegionPicker
            availableLevels={availableLevels}
            value={region}
            onChange={handleRegionChange}
            tileAreaCap={cap}
            disabled={disabled}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {region ? (
              <>
                <span>
                  {t("contributePage.regionField.selection", {
                    count: area.toLocaleString(),
                    suffix: area === 1 ? "" : "s",
                  })}
                </span>
                {cap != null && (
                  <span className={overCap ? "text-destructive" : ""}>
                    ·{" "}
                    {t("contributePage.regionField.cap", {
                      count: cap.toLocaleString(),
                      over: overCap ? t("contributePage.regionField.capOver") : "",
                    })}
                  </span>
                )}
              </>
            ) : (
              <span className="text-warning">
                {t("contributePage.regionField.drawRectangleWarning")}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

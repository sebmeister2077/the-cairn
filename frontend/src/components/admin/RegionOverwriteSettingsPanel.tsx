/**
 * RegionOverwriteSettingsPanel — admin UI for the region-overwrite quotas.
 *
 * Mounted under the ``region_overwrite`` operational/product flag area on
 * the AdminFeatureFlagsPage. Exposes:
 *
 * 1. ``max_chunks_area_non_admin`` (chunks² area cap for non-admin
 *    contributors using the region picker). 30×30 ≈ 900 is the launch
 *    default; widening this lets trusted contributors update larger
 *    swaths in a single submission.
 * 2. ``admin_expand_chunks_max`` (per-edge chunks the admin reviewer may
 *    add to a contributor's selected bounds before approving). Defaults
 *    to 10 chunks ≈ 320 blocks.
 *
 * Both values are clamped server-side so client-side validation here is
 * cosmetic — focus is on showing the units (chunks vs. chunks²) and the
 * implied block equivalents so the operator doesn't have to do mental
 * math.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  adminGetRegionOverwriteSettings,
  adminSetRegionOverwriteSettings,
  type RegionOverwriteSettings,
} from "@/lib/api";
import { Button } from "@/components/ui/button";

// VS chunk side length in blocks. Matches the backend constant
// ``TILE_SIZE``; duplicated here for the implied-block-area hint.
const TILE_BLOCKS = 32;

function formatBlockArea(chunksArea: number): string {
  const blocks = chunksArea * TILE_BLOCKS * TILE_BLOCKS;
  if (blocks < 1_000_000) return `${blocks.toLocaleString()} blocks²`;
  return `${(blocks / 1_000_000).toFixed(2)} million blocks²`;
}

function approxSquareSide(chunksArea: number): string {
  const side = Math.round(Math.sqrt(chunksArea));
  return `≈ ${side}×${side} chunks`;
}

export function RegionOverwriteSettingsPanel() {
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ["admin", "region-overwrite-settings"],
    queryFn: adminGetRegionOverwriteSettings,
  });

  // Local edit state — only flushed to the server on Save. Initial
  // empty-string placeholder avoids flashing 0 before the query resolves.
  const [maxArea, setMaxArea] = useState<number>(900);
  const [expandMax, setExpandMax] = useState<number>(10);

  useEffect(() => {
    if (settingsQuery.data) {
      setMaxArea(settingsQuery.data.max_chunks_area_non_admin);
      setExpandMax(settingsQuery.data.admin_expand_chunks_max);
    }
  }, [settingsQuery.data]);

  const dirty = useMemo(() => {
    if (!settingsQuery.data) return false;
    return (
      maxArea !== settingsQuery.data.max_chunks_area_non_admin ||
      expandMax !== settingsQuery.data.admin_expand_chunks_max
    );
  }, [maxArea, expandMax, settingsQuery.data]);

  const valid =
    Number.isFinite(maxArea) &&
    maxArea >= 1 &&
    maxArea <= 1_000_000 &&
    Number.isFinite(expandMax) &&
    expandMax >= 0 &&
    expandMax <= 256;

  const saveMutation = useMutation({
    mutationFn: (body: RegionOverwriteSettings) => adminSetRegionOverwriteSettings(body),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "region-overwrite-settings"],
      });
    },
  });

  const handleSave = () => {
    if (!valid || !dirty) return;
    saveMutation.mutate({
      max_chunks_area_non_admin: maxArea,
      admin_expand_chunks_max: expandMax,
    });
  };

  return (
    <div className="rounded border p-3 space-y-4 bg-muted/40">
      <div className="text-xs">
        <p className="font-medium">Region-overwrite limits</p>
        <p className="text-muted-foreground">
          Caps for the contributor region picker and the admin "expand before approve" flow. Units
          are <em>chunks</em> (1 chunk = {TILE_BLOCKS} blocks). Changes apply immediately to new
          requests; in-flight previews are unaffected.
        </p>
      </div>

      {/* Non-admin chunks² cap */}
      <div className="space-y-2">
        <label htmlFor="region-max-area" className="text-xs font-medium block">
          Non-admin selection cap (chunks²)
        </label>
        <div className="flex items-center gap-2">
          <input
            id="region-max-area"
            type="number"
            min={1}
            max={1_000_000}
            step={1}
            value={Number.isFinite(maxArea) ? maxArea : ""}
            onChange={(e) => setMaxArea(parseInt(e.target.value, 10))}
            className="w-32 rounded border bg-background px-2 py-1 text-sm font-mono"
          />
          <span className="text-xs text-muted-foreground">
            chunks² &middot; {approxSquareSide(maxArea)} &middot; {formatBlockArea(maxArea)}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Maximum area a non-admin contributor (with the <code>region_overwrite</code> permission)
          may select. The 900 default ≈ 30×30 chunks ≈ 960×960 blocks, comfortably covering a single
          VS region. Admins bypass this cap entirely.
        </p>
      </div>

      {/* Admin per-edge expansion cap */}
      <div className="space-y-2">
        <label htmlFor="region-expand-max" className="text-xs font-medium block">
          Admin per-edge expansion cap (chunks)
        </label>
        <div className="flex items-center gap-2">
          <input
            id="region-expand-max"
            type="number"
            min={0}
            max={256}
            step={1}
            value={Number.isFinite(expandMax) ? expandMax : ""}
            onChange={(e) => setExpandMax(parseInt(e.target.value, 10))}
            className="w-32 rounded border bg-background px-2 py-1 text-sm font-mono"
          />
          <span className="text-xs text-muted-foreground">
            chunks &middot; ± {expandMax * TILE_BLOCKS} blocks per edge
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Maximum number of chunks an admin reviewer may add to each edge of a contributor's
          selected bounds before approving. Shrinking is always unlimited; only expansion is capped.
          Set to 0 to forbid any expansion (admin can still tighten the bounds).
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-[11px] text-muted-foreground">
          {settingsQuery.isLoading ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading…
            </span>
          ) : saveMutation.isError ? (
            <span className="text-destructive">
              Save failed: {(saveMutation.error as Error)?.message ?? "unknown"}
            </span>
          ) : saveMutation.isSuccess && !dirty ? (
            <span>Saved.</span>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || !valid || saveMutation.isPending}
          onClick={handleSave}
        >
          {saveMutation.isPending ? (
            <>
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              Saving…
            </>
          ) : (
            "Save"
          )}
        </Button>
      </div>
    </div>
  );
}

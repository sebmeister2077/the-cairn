/**
 * Phase C — admin-only panel to review & edit a pending region-overwrite
 * contribution.
 *
 * Lives in its own file so {@link PendingContributionsSection} stays
 * focused on row layout and shared (admin + contributor) actions.
 *
 * Features:
 * - Numeric per-edge chunk inputs (min_x / max_x / min_z / max_z),
 *   displayed in chunks and converted to blocks before sending.
 * - Live diff against the original bounds. Each edge has a visible
 *   "expansion" delta and is clamped against
 *   ``region_admin_expand_chunks_max`` from the feature settings.
 * - Padded before/after preview slider (0..5 chunks of context).
 * - Save / Reset / "Open in TOPS viewer" actions. Save invokes the
 *   backend PATCH endpoint, then bumps a refreshKey to force the
 *   {@link ContributionBeforeAfter} to re-fetch the regenerated PNGs.
 */

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, MapPin, RefreshCcw, Save, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import {
  adminEditContributionRegion,
  normalizeContributionRegion,
  type ContributionRegion,
} from "@/lib/api";
import { contributeQueries } from "@/lib/constants/react-query";
import { ContributionBeforeAfter } from "../ContributionBeforeAfter";
import type { ContributeInfo, PendingContribution } from "@/models/contributions";

const TILE_SIZE = 32;

interface Props {
  contribution: PendingContribution;
  contributeInfo: ContributeInfo;
  /** Called after the admin saves new bounds so the parent can refresh
   *  the pending-contributions list (which carries the persisted
   *  ``update_region`` back to all viewers). */
  onSaved?: () => void;
}

/** A region edge expressed in chunk indices (inclusive on both ends). */
interface ChunkRegion {
  min_tx: number;
  max_tx: number;
  min_tz: number;
  max_tz: number;
}

function regionToChunks(r: ContributionRegion): ChunkRegion {
  return {
    min_tx: Math.floor(r.min_x / TILE_SIZE),
    max_tx: Math.floor(r.max_x / TILE_SIZE),
    min_tz: Math.floor(r.min_z / TILE_SIZE),
    max_tz: Math.floor(r.max_z / TILE_SIZE),
  };
}

function chunksToRegion(c: ChunkRegion): ContributionRegion {
  return {
    min_x: c.min_tx * TILE_SIZE,
    max_x: (c.max_tx + 1) * TILE_SIZE - 1,
    min_z: c.min_tz * TILE_SIZE,
    max_z: (c.max_tz + 1) * TILE_SIZE - 1,
  };
}

export function AdminRegionReviewPanel({ contribution, contributeInfo, onSaved }: Props) {
  const queryClient = useQueryClient();
  const original = normalizeContributionRegion(contribution.update_region);
  const expandMax = Math.max(0, Math.floor(contributeInfo.region_admin_expand_chunks_max ?? 0));

  const originalChunks = useMemo(() => (original ? regionToChunks(original) : null), [original]);

  const [edited, setEdited] = useState<ChunkRegion | null>(originalChunks);
  const [padding, setPadding] = useState<number>(5);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  if (!original || !originalChunks || !edited) {
    // The bounds were redacted for this viewer or the contribution
    // isn't a region-overwrite — nothing to edit.
    return null;
  }

  // Per-edge expansion in chunks (negative = shrink, positive = grow).
  // `min_*` edges grow when the new value is *less* than the original
  // (we expand the rectangle outward), so the sign flips.
  const expansions = {
    min_x: originalChunks.min_tx - edited.min_tx,
    max_x: edited.max_tx - originalChunks.max_tx,
    min_z: originalChunks.min_tz - edited.min_tz,
    max_z: edited.max_tz - originalChunks.max_tz,
  } as const;

  const overEdges = (Object.entries(expansions) as Array<[keyof typeof expansions, number]>)
    .filter(([, v]) => v > expandMax)
    .map(([k]) => k);

  const dirty =
    edited.min_tx !== originalChunks.min_tx ||
    edited.max_tx !== originalChunks.max_tx ||
    edited.min_tz !== originalChunks.min_tz ||
    edited.max_tz !== originalChunks.max_tz;

  const valid =
    edited.max_tx >= edited.min_tx && edited.max_tz >= edited.min_tz && overEdges.length === 0;

  const chunkArea =
    Math.max(0, edited.max_tx - edited.min_tx + 1) * Math.max(0, edited.max_tz - edited.min_tz + 1);

  const centerX = Math.floor(((edited.min_tx + edited.max_tx + 1) * TILE_SIZE) / 2);
  const centerZ = Math.floor(((edited.min_tz + edited.max_tz + 1) * TILE_SIZE) / 2);

  function updateEdge(key: keyof ChunkRegion, raw: string) {
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed)) return;
    setEdited((prev) => (prev ? { ...prev, [key]: parsed } : prev));
  }

  function resetEdits() {
    setEdited(originalChunks);
    setError(null);
  }

  async function handleSave() {
    if (!edited || !valid || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      await adminEditContributionRegion(contribution.id, chunksToRegion(edited));
      setRefreshKey((k) => k + 1);
      queryClient.invalidateQueries({
        queryKey: contributeQueries.contributeInfo.queryKey,
      });
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-dashed bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Badge variant="outline">admin region review</Badge>
          <span className="text-muted-foreground">
            Original: x [{originalChunks.min_tx}, {originalChunks.max_tx}], z [
            {originalChunks.min_tz}, {originalChunks.max_tz}] chunks
          </span>
        </div>
        <a
          href={`/multiplayer/tops-map?x=${centerX}&z=${centerZ}&zoom=2`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Open in TOPS viewer
        </a>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <EdgeInput
          label="min X (chunks)"
          value={edited.min_tx}
          onChange={(v) => updateEdge("min_tx", v)}
          expansion={expansions.min_x}
          expandMax={expandMax}
          disabled={saving}
        />
        <EdgeInput
          label="max X (chunks)"
          value={edited.max_tx}
          onChange={(v) => updateEdge("max_tx", v)}
          expansion={expansions.max_x}
          expandMax={expandMax}
          disabled={saving}
        />
        <EdgeInput
          label="min Z (chunks)"
          value={edited.min_tz}
          onChange={(v) => updateEdge("min_tz", v)}
          expansion={expansions.min_z}
          expandMax={expandMax}
          disabled={saving}
        />
        <EdgeInput
          label="max Z (chunks)"
          value={edited.max_tz}
          onChange={(v) => updateEdge("max_tz", v)}
          expansion={expansions.max_z}
          expandMax={expandMax}
          disabled={saving}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          Edited: <strong>{chunkArea.toLocaleString()}</strong> chunk
          {chunkArea === 1 ? "" : "s"}
        </span>
        <span>
          · Per-edge expansion cap: <strong>{expandMax}</strong> chunk
          {expandMax === 1 ? "" : "s"}
        </span>
        {overEdges.length > 0 && (
          <span className="text-destructive">· over cap: {overEdges.join(", ")}</span>
        )}
        {!valid && overEdges.length === 0 && (
          <span className="text-destructive">· invalid (max &lt; min)</span>
        )}
      </div>

      <div className="space-y-1">
        <Label className="text-xs">
          Preview padding: <strong>{padding}</strong> chunk{padding === 1 ? "" : "s"}
        </Label>
        <Slider
          min={0}
          max={20}
          step={1}
          value={padding}
          onValueChange={(v) => setPadding(v)}
          disabled={saving}
        />
      </div>

      <ContributionBeforeAfter
        contributionId={contribution.id}
        paddingChunks={padding}
        refreshKey={refreshKey}
        region={chunksToRegion(edited)}
      />

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={handleSave} disabled={!dirty || !valid || saving}>
          {saving ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="mr-1 h-3.5 w-3.5" />
          )}
          Save bounds
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={resetEdits}
          disabled={!dirty || saving}
        >
          <RefreshCcw className="mr-1 h-3.5 w-3.5" /> Reset to original
        </Button>
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
          <MapPin className="h-3.5 w-3.5" /> center ({centerX}, {centerZ})
        </span>
      </div>
    </div>
  );
}

function EdgeInput({
  label,
  value,
  onChange,
  expansion,
  expandMax,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (value: string) => void;
  expansion: number;
  expandMax: number;
  disabled?: boolean;
}) {
  const over = expansion > expandMax;
  const sign = expansion > 0 ? `+${expansion}` : `${expansion}`;
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="h-8 text-sm"
      />
      <div className={`text-[10px] ${over ? "text-destructive" : "text-muted-foreground"}`}>
        Δ {sign} chunk{Math.abs(expansion) === 1 ? "" : "s"}
        {over && ` (> ${expandMax})`}
      </div>
    </div>
  );
}

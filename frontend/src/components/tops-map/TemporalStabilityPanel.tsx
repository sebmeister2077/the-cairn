import { useCallback } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  setStabilityEnabled as setStabilityEnabledAction,
  setStabilityYSlice as setStabilityYSliceAction,
  setStabilityOpacity as setStabilityOpacityAction,
} from "@/store/slices/mapView";
import { getStabilityRootMeta } from "@/lib/stability/loader";
import {
  snapToStabilitySlice,
  STABILITY_Y_MAX,
  STABILITY_Y_MIN,
  STABILITY_Y_STEP,
  type StabilitySliceMeta,
} from "@/lib/stability/types";

interface TemporalStabilityPanelProps {
  /** Active depth-slice metadata (stats). `null` while disabled/loading. */
  sliceMeta: StabilitySliceMeta | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
}

function GradientLegend({ sliceMeta }: { sliceMeta: StabilitySliceMeta | null }) {
  const { colorAnchors, stabilityRange } = getStabilityRootMeta();
  if (colorAnchors.length === 0) return null;
  const lo = stabilityRange.min;
  const hi = stabilityRange.max;
  const span = hi - lo;
  const stops = colorAnchors
    .map((a) => {
      const pct = span > 0 ? ((a.value - lo) / span) * 100 : 0;
      return `${a.hex} ${pct.toFixed(2)}%`;
    })
    .join(", ");
  return (
    <div className="flex flex-col gap-1">
      <div
        className="h-2 w-full rounded-sm border"
        style={{ background: `linear-gradient(to right, ${stops})` }}
        aria-hidden
      />
      <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{lo.toFixed(1)}</span>
        <span>1.0</span>
        <span>{hi.toFixed(1)}</span>
      </div>
      {sliceMeta && (
        <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
          <span>min {sliceMeta.stats.min.toFixed(2)}</span>
          <span>avg {sliceMeta.stats.avg.toFixed(2)}</span>
          <span>max {sliceMeta.stats.max.toFixed(2)}</span>
        </div>
      )}
    </div>
  );
}

export function TemporalStabilityPanel({ sliceMeta, status, error }: TemporalStabilityPanelProps) {
  const dispatch = useAppDispatch();

  const enabled = useAppSelector((s) => s.mapView.stabilityEnabled);
  const ySlice = useAppSelector((s) => s.mapView.stabilityYSlice);
  const opacity = useAppSelector((s) => s.mapView.stabilityOpacity);

  const setEnabled = useCallback(
    (next: boolean) => dispatch(setStabilityEnabledAction(next)),
    [dispatch],
  );
  const setYSlice = useCallback(
    (next: number) => dispatch(setStabilityYSliceAction(snapToStabilitySlice(next))),
    [dispatch],
  );
  const setOpacity = useCallback(
    (next: number) => dispatch(setStabilityOpacityAction(next)),
    [dispatch],
  );

  return (
    <div className="flex flex-col rounded-md border bg-background/95 px-3 py-2 text-sm shadow-md backdrop-blur">
      {/* Master row */}
      <div className="cursor-pointer flex items-center gap-2" onClick={() => setEnabled(!enabled)}>
        <Switch checked={enabled} aria-label="Temporal stability" />
        <Label className="cursor-pointer">Temporal stability</Label>
        {status === "loading" && enabled && (
          <span className="text-xs text-muted-foreground ml-1">…</span>
        )}
        {status === "error" && error && (
          <span className="text-xs text-red-500 ml-1 truncate" title={error}>
            {error}
          </span>
        )}
      </div>

      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: enabled ? "1fr" : "0fr" }}
        aria-hidden={!enabled}
      >
        <div className="overflow-hidden min-h-0">
          <div className="flex flex-col gap-2 pt-2">
            <p className="text-[11px] text-muted-foreground leading-snug">
              Base temporal stability by depth. Deeper slices are less stable — drag the slider to
              inspect each Y level.
            </p>

            <GradientLegend sliceMeta={sliceMeta} />

            {/* Y depth slider */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-12 shrink-0">Y level</span>
              <Slider
                value={ySlice}
                min={STABILITY_Y_MIN}
                max={STABILITY_Y_MAX}
                step={STABILITY_Y_STEP}
                onValueChange={setYSlice}
                aria-label="Stability depth (Y)"
                className="flex-1"
                disabled={!enabled}
              />
              <span className="text-[10px] text-muted-foreground tabular-nums w-8 text-right">
                {ySlice}
              </span>
            </div>

            {/* Opacity slider */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-12 shrink-0">Opacity</span>
              <Slider
                value={Math.round(opacity * 100)}
                min={0}
                max={100}
                step={5}
                onValueChange={(v) => setOpacity(v / 100)}
                aria-label="Stability opacity"
                className="flex-1"
                disabled={!enabled}
              />
              <span className="text-[10px] text-muted-foreground tabular-nums w-8 text-right">
                {Math.round(opacity * 100)}%
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

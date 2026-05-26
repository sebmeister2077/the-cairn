// User-facing icon picker for the three special marker kinds rendered on
// the TOPS map (Trader / Translocator / Terminus). Lives in the Account
// page's "Appearance" card and writes to the `mapView` slice — values are
// persisted via the root envelope and shared across tabs.

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { useAppDispatch, useReduxState } from "@/store/hooks";
import { setTerminusStyle, setTLStyle, setTraderStyle } from "@/store/slices/mapView";
import {
  drawTerminusMarker,
  drawTLEndpoint,
  drawTraderMarker,
  type TerminusStyle,
  type TLStyle,
  type TraderStyle,
  TERMINUS_STYLE_OPTIONS,
  TL_STYLE_OPTIONS,
  TRADER_STYLE_OPTIONS,
} from "@/lib/markerStyles";

// Swatch size in device-independent pixels. The canvas is rendered at
// devicePixelRatio for sharpness on hi-DPI displays.
const SWATCH_PX = 40;
// Zoom passed to the draw helpers. Lower zoom → larger icon (sizes are
// computed as `max(N, M / zoom)`), so we use a small zoom to fill the swatch.
const SWATCH_ZOOM = 0.55;

type DrawFn = (ctx: CanvasRenderingContext2D) => void;

function Swatch({ draw, selected }: { draw: DrawFn; selected: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = SWATCH_PX * dpr;
    canvas.height = SWATCH_PX * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SWATCH_PX, SWATCH_PX);
    ctx.translate(SWATCH_PX / 2, SWATCH_PX / 2);
    draw(ctx);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, [draw, selected]);

  return (
    <canvas
      ref={ref}
      style={{ width: SWATCH_PX, height: SWATCH_PX }}
      className="block"
      aria-hidden
    />
  );
}

function OptionButton({
  label,
  hint,
  selected,
  onSelect,
  draw,
}: {
  label: string;
  hint: string;
  selected: boolean;
  onSelect: () => void;
  draw: DrawFn;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={hint}
      aria-pressed={selected}
      className={cn(
        "group flex flex-col items-center gap-1 rounded-md border bg-card p-2 text-xs transition-colors",
        "hover:border-primary/60 hover:bg-accent",
        selected ? "border-primary ring-2 ring-primary/40" : "border-border",
      )}
    >
      <Swatch draw={draw} selected={selected} />
      <span className="font-medium leading-tight">{label}</span>
    </button>
  );
}

const TRADER_COLOR = "rgba(34, 211, 238, 0.92)";
const TL_COLOR = "rgba(167, 139, 250, 0.95)";

export function MarkerStylePicker() {
  const dispatch = useAppDispatch();
  const traderStyle = useReduxState("mapView.traderStyle");
  const tlStyle = useReduxState("mapView.tlStyle");
  const terminusStyle = useReduxState("mapView.terminusStyle");

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="space-y-0.5">
          <Label>Trader icon</Label>
          <p className="text-xs text-muted-foreground">
            How merchants and traveling traders appear on the map.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {TRADER_STYLE_OPTIONS.map((opt) => (
            <OptionButton
              key={opt.id}
              label={opt.label}
              hint={opt.hint}
              selected={traderStyle === opt.id}
              onSelect={() => dispatch(setTraderStyle(opt.id as TraderStyle))}
              draw={(ctx) => drawTraderMarker(ctx, 0, 0, SWATCH_ZOOM, opt.id, TRADER_COLOR)}
            />
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="space-y-0.5">
          <Label>Translocator endpoint</Label>
          <p className="text-xs text-muted-foreground">
            Marker drawn at each end of a translocator route.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {TL_STYLE_OPTIONS.map((opt) => (
            <OptionButton
              key={opt.id}
              label={opt.label}
              hint={opt.hint}
              selected={tlStyle === opt.id}
              onSelect={() => dispatch(setTLStyle(opt.id as TLStyle))}
              draw={(ctx) => drawTLEndpoint(ctx, 0, 0, SWATCH_ZOOM, opt.id, TL_COLOR)}
            />
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="space-y-0.5">
          <Label>Terminus icon</Label>
          <p className="text-xs text-muted-foreground">
            One-way death-return waypoints. Icon-only — no label is rendered.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {TERMINUS_STYLE_OPTIONS.map((opt) => (
            <OptionButton
              key={opt.id}
              label={opt.label}
              hint={opt.hint}
              selected={terminusStyle === opt.id}
              onSelect={() => dispatch(setTerminusStyle(opt.id as TerminusStyle))}
              draw={(ctx) => drawTerminusMarker(ctx, 0, 0, SWATCH_ZOOM, opt.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

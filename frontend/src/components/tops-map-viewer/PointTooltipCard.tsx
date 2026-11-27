import type { PointTooltip } from "@/components/tops-map-viewer/MapViewer";

/** Hover tooltip state shared by both map viewers. `left`/`top` are
 *  container-relative pixel coordinates of the cursor. */
export interface HoveredPointTooltip extends PointTooltip {
  left: number;
  top: number;
  kind?: string;
  claimed?: boolean;
}

function headingFor(tip: HoveredPointTooltip): string {
  if (tip.title) return tip.title;
  if (tip.kind === "Rapids") return tip.claimed ? "Rapids · claimed" : "Rapids · unclaimed";
  return "Broken TL";
}

function headingClass(tip: HoveredPointTooltip): string {
  if (tip.kind === "Rapids" || tip.kind === "RapidsCluster") {
    return tip.claimed ? "text-orange-300" : "text-teal-300";
  }
  return "text-red-300";
}

/** Floating X/Y/Z readout for point markers that carry a `tooltip` payload. */
export function PointTooltipCard({ tip }: { tip: HoveredPointTooltip }) {
  return (
    <div
      className="absolute z-20 rounded bg-black/85 px-2 py-1 text-xs font-mono text-white pointer-events-none whitespace-nowrap shadow-lg"
      style={{ left: tip.left + 14, top: tip.top + 14 }}
    >
      <div className={"text-[10px] font-semibold uppercase tracking-wide " + headingClass(tip)}>
        {headingFor(tip)}
      </div>
      {!tip.hideCoords && (
        <div>
          X: {Math.round(tip.x)} &nbsp; Y: {Math.round(tip.y)} &nbsp; Z: {Math.round(tip.z)}
        </div>
      )}
      {tip.detail && <div className="text-white/75">{tip.detail}</div>}
    </div>
  );
}

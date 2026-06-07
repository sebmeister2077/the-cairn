// 3D viewer for the tunnel tool. Heavy module — three.js,
// react-three-fiber, drei — so it's lazy-imported by ToolsTunnelPage to
// keep the main bundle thin. Default-exported so React.lazy works.

import { useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { TUNNEL_MAX_BLOCKS } from "@/lib/tunnel-pattern";
import type { MultiSegment, TLEndpoint, EdgeKey } from "@/lib/tunnel-multi";
import type { Block3 } from "@/lib/tunnel-share";

import { CompassLabels, useCompassRefs } from "./CompassOverlay";
import { TunnelScene } from "./TunnelScene";

interface TunnelViewer3DProps {
  segments: MultiSegment[];
  endpoints: TLEndpoint[];
  junction: Block3 | null;
  selectedEdge: EdgeKey | null;
}

interface UnionBounds {
  min: Block3;
  max: Block3;
}

function unionBounds(
  segments: MultiSegment[],
  endpoints: TLEndpoint[],
  junction: Block3 | null,
): UnionBounds {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const consider = (p: Block3) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  };
  for (const ep of endpoints) consider(ep.coord);
  for (const seg of segments) {
    consider(seg.fromCoord);
    consider(seg.toCoord);
    if (seg.path.length > 0) {
      consider(seg.path[0]);
      consider(seg.path[seg.path.length - 1]);
    }
  }
  if (junction) consider(junction);
  if (!Number.isFinite(minX)) {
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  }
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

function boundsCenterRadius(b: UnionBounds): {
  center: [number, number, number];
  radius: number;
} {
  const cx = (b.min.x + b.max.x) / 2 + 0.5;
  const cy = (b.min.y + b.max.y) / 2 + 0.5;
  const cz = (b.min.z + b.max.z) / 2 + 0.5;
  const radius = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) / 2 + 1;
  return { center: [cx, cy, cz], radius };
}

function totalPathBlocks(segments: MultiSegment[]): number {
  let total = 0;
  for (const seg of segments) total += seg.path.length;
  return total;
}

function TunnelViewer3D({ segments, endpoints, junction, selectedEdge }: TunnelViewer3DProps) {
  const { t } = useTranslation();
  const compassRefs = useCompassRefs();
  const [recenterToken, setRecenterToken] = useState(0);
  const [warningDismissed, setWarningDismissed] = useState(false);

  const bounds = useMemo(
    () => unionBounds(segments, endpoints, junction),
    [segments, endpoints, junction],
  );
  const { center, radius } = boundsCenterRadius(bounds);

  const overLimit = totalPathBlocks(segments) > TUNNEL_MAX_BLOCKS;

  return (
    <div className="relative h-full min-h-105 w-full overflow-hidden rounded-md border bg-[#1a1a1a]">
      <Canvas shadows={false} camera={{ fov: 55, near: 0.1, far: 4000 }} dpr={[1, 2]}>
        <color attach="background" args={["#1a1a1a"]} />
        <TunnelScene
          segments={segments}
          endpoints={endpoints}
          junction={junction}
          selectedEdge={selectedEdge}
          center={center}
          radius={radius}
          compassRefs={compassRefs}
          recenterToken={recenterToken}
        />
      </Canvas>

      <CompassLabels refs={compassRefs} />

      <div className="absolute right-2 top-2 flex gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setRecenterToken((n) => n + 1)}
          className="shadow"
        >
          <RotateCcw className="mr-1 h-3 w-3" />
          {t("tools.tunnel.recenter")}
        </Button>
      </div>

      {overLimit && !warningDismissed && (
        <div className="pointer-events-auto absolute bottom-2 left-2 right-2 flex items-start gap-2 rounded border border-amber-500/30 bg-amber-50/95 px-3 py-2 text-xs text-amber-900 shadow dark:bg-amber-950/80 dark:text-amber-100">
          <div className="flex-1">
            <div className="font-semibold">{t("tools.tunnel.previewCapTitle")}</div>
            <div>{t("tools.tunnel.previewCapBody", { limit: TUNNEL_MAX_BLOCKS })}</div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setWarningDismissed(true)}
            aria-label="Dismiss"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

export default TunnelViewer3D;

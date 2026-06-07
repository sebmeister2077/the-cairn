// Three.js scene: per-segment instanced tunnel blocks (color-tinted
// per branch), one emissive marker per endpoint + an optional junction
// marker, dashed reference line per segment, and a small axis gizmo.

import { useEffect, useMemo, useRef } from "react";
import {
  GizmoHelper,
  GizmoViewport,
  Html,
  Instance,
  Instances,
  Line,
  OrbitControls,
} from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { Color, Vector3 } from "three";

import { useTranslation } from "@/lib/i18n";
import { TUNNEL_MAX_BLOCKS, type PathBlock } from "@/lib/tunnel-pattern";
import { HUB_ID, type EdgeKey, type MultiSegment, type TLEndpoint } from "@/lib/tunnel-multi";
import {
  JUNCTION_COLOR,
  SEGMENT_BLOCK_FALLBACK,
  endpointColor,
} from "@/lib/tunnel-colors";
import type { Block3 } from "@/lib/tunnel-share";

import { CompassTracker, type CompassRefs } from "./CompassOverlay";

interface TunnelSceneProps {
  segments: MultiSegment[];
  endpoints: TLEndpoint[];
  junction: Block3 | null;
  /** Highlighted segment (matches PatternCard selection). */
  selectedEdge: EdgeKey | null;
  /** Geometric centre of the unioned bounds; the camera frames around this. */
  center: [number, number, number];
  /** Half-extent of the unioned bounds; used to choose orbit distance. */
  radius: number;
  compassRefs: CompassRefs;
  /** Bumped whenever the user wants the camera reset to the auto-frame. */
  recenterToken: number;
}

/** Tint the blocks of a hub branch with the owning endpoint's color;
 *  for pair / tour segments use a neutral grey so colours don't clash. */
function segmentTint(seg: MultiSegment, idxByEpId: Map<string, number>): string {
  if (seg.toId === HUB_ID) {
    const idx = idxByEpId.get(seg.fromId);
    return idx !== undefined ? endpointColor(idx) : SEGMENT_BLOCK_FALLBACK;
  }
  return SEGMENT_BLOCK_FALLBACK;
}

/** Brighten + slightly desaturate a hex color for the selected-segment
 *  highlight. Operates in HSL so the original hue is preserved. */
function brighten(hex: string, amount = 0.25): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const nl = Math.min(1, l + amount);
  const factor = nl / Math.max(0.0001, l);
  const nr = Math.min(255, Math.round(r * 255 * factor));
  const ng = Math.min(255, Math.round(g * 255 * factor));
  const nb = Math.min(255, Math.round(b * 255 * factor));
  return `#${nr.toString(16).padStart(2, "0")}${ng.toString(16).padStart(2, "0")}${nb.toString(16).padStart(2, "0")}`;
}

/** Cap merged voxels across all segments so a 50k-block network
 *  doesn't melt the GPU. Earlier segments get priority; the rest are
 *  silently truncated. Stats reflect the full path lengths. */
function capSegmentBlocks(segments: MultiSegment[]): {
  perSegment: PathBlock[][];
  truncated: boolean;
} {
  let budget = TUNNEL_MAX_BLOCKS;
  const out: PathBlock[][] = [];
  let truncated = false;
  for (const seg of segments) {
    if (budget <= 0) {
      out.push([]);
      truncated = true;
      continue;
    }
    if (seg.path.length <= budget) {
      out.push(seg.path);
      budget -= seg.path.length;
    } else {
      out.push(seg.path.slice(0, budget));
      truncated = true;
      budget = 0;
    }
  }
  return { perSegment: out, truncated };
}

export function TunnelScene({
  segments,
  endpoints,
  junction,
  selectedEdge,
  center,
  radius,
  compassRefs,
  recenterToken,
}: TunnelSceneProps) {
  const { t } = useTranslation();
  const idxByEpId = useMemo(() => {
    const m = new Map<string, number>();
    endpoints.forEach((e, i) => m.set(e.id, i));
    return m;
  }, [endpoints]);

  const { perSegment } = useMemo(() => capSegmentBlocks(segments), [segments]);

  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[80, 120, 60]} intensity={0.9} />
      <directionalLight position={[-60, 40, -80]} intensity={0.35} />

      {segments.map((seg, i) => {
        const baseColor = segmentTint(seg, idxByEpId);
        const isSelected = selectedEdge === seg.key;
        return (
          <SegmentBlocks
            key={seg.key}
            blocks={perSegment[i] ?? []}
            color={isSelected ? brighten(baseColor, 0.28) : baseColor}
            emissive={isSelected ? 0.35 : 0}
          />
        );
      })}

      {endpoints.map((ep, i) => (
        <EndpointMarker
          key={ep.id}
          position={[ep.coord.x + 0.5, ep.coord.y + 0.5, ep.coord.z + 0.5]}
          color={endpointColor(i)}
          label={ep.label?.trim() || t("tools.tunnel.endpointDefaultLabel", { index: i + 1 })}
          coords={ep.coord}
          size={1.05}
        />
      ))}

      {junction && (
        <EndpointMarker
          position={[junction.x + 0.5, junction.y + 0.5, junction.z + 0.5]}
          color={JUNCTION_COLOR}
          label={t("tools.tunnel.hubMarker")}
          coords={junction}
          size={1.25}
        />
      )}

      {segments.map((seg) => {
        const isSelected = selectedEdge === seg.key;
        return (
          <Line
            key={`ref-${seg.key}`}
            points={[
              [seg.fromCoord.x + 0.5, seg.fromCoord.y + 0.5, seg.fromCoord.z + 0.5],
              [seg.toCoord.x + 0.5, seg.toCoord.y + 0.5, seg.toCoord.z + 0.5],
            ]}
            color={isSelected ? "#fde68a" : "#ffffff"}
            lineWidth={isSelected ? 2.5 : 1}
            dashed={!isSelected}
            dashSize={0.6}
            gapSize={0.4}
            transparent
            opacity={isSelected ? 0.9 : 0.4}
          />
        );
      })}

      <CompassTracker refs={compassRefs} />
      <CameraFramer center={center} radius={radius} token={recenterToken} />

      <OrbitControls makeDefault enableDamping dampingFactor={0.1} />

      <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
        <GizmoViewport axisColors={["#ef4444", "#22c55e", "#3b82f6"]} labelColor="white" />
      </GizmoHelper>
    </>
  );
}

function SegmentBlocks({
  blocks,
  color,
  emissive = 0,
}: {
  blocks: PathBlock[];
  color: string;
  emissive?: number;
}) {
  const blockColor = useMemo(() => new Color(color), [color]);
  if (blocks.length === 0) return null;
  const fullBlocks: PathBlock[] = [];
  const slabBlocks: PathBlock[] = [];
  for (const b of blocks) {
    if (b.slab) slabBlocks.push(b);
    else fullBlocks.push(b);
  }
  return (
    <>
      {fullBlocks.length > 0 && (
        <Instances limit={TUNNEL_MAX_BLOCKS} range={fullBlocks.length}>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial
            color={blockColor}
            emissive={blockColor}
            emissiveIntensity={emissive}
            roughness={0.85}
            metalness={0.05}
          />
          {fullBlocks.map((b, i) => (
            <Instance key={i} position={[b.x + 0.5, b.y + 0.5, b.z + 0.5]} />
          ))}
        </Instances>
      )}
      {slabBlocks.length > 0 && (
        <Instances limit={TUNNEL_MAX_BLOCKS} range={slabBlocks.length}>
          <boxGeometry args={[1, 0.5, 1]} />
          <meshStandardMaterial
            color={blockColor}
            emissive={blockColor}
            emissiveIntensity={emissive}
            roughness={0.85}
            metalness={0.05}
          />
          {slabBlocks.map((b, i) => (
            <Instance
              key={i}
              position={[b.x + 0.5, b.y + (b.slab === "top" ? 0.75 : 0.25), b.z + 0.5]}
            />
          ))}
        </Instances>
      )}
    </>
  );
}

function EndpointMarker({
  position,
  color,
  label,
  coords,
  size,
}: {
  position: [number, number, number];
  color: string;
  label: string;
  coords: Block3;
  size: number;
}) {
  return (
    <group position={position}>
      <mesh>
        <boxGeometry args={[size, size, size]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.55}
          roughness={0.5}
        />
      </mesh>
      <Html center position={[0, 1.1, 0]} style={{ pointerEvents: "none" }} distanceFactor={20}>
        <div className="whitespace-nowrap rounded bg-background/90 px-1.5 py-0.5 font-mono text-[10px] text-foreground shadow ring-1 ring-foreground/10">
          <div className="font-semibold">{label}</div>
          <div className="opacity-80">
            {coords.x}, {coords.y}, {coords.z}
          </div>
        </div>
      </Html>
    </group>
  );
}

function CameraFramer({
  center,
  radius,
  token,
}: {
  center: [number, number, number];
  radius: number;
  token: number;
}) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target?: Vector3; update?: () => void } | null;
  const framed = useRef<{ token: number | null; hadControls: boolean }>({
    token: null,
    hadControls: false,
  });

  useEffect(() => {
    const hasControls = !!controls?.target;
    const tokenChanged = framed.current.token !== token;
    const controlsJustArrived = !framed.current.hadControls && hasControls;
    if (!tokenChanged && !controlsJustArrived) return;

    framed.current = { token, hadControls: hasControls };
    const dist = Math.max(20, radius * 2.5);
    camera.position.set(center[0] + dist, center[1] + dist * 0.7, center[2] + dist);
    camera.lookAt(center[0], center[1], center[2]);
    camera.updateProjectionMatrix();
    if (controls?.target) {
      controls.target.set(center[0], center[1], center[2]);
      controls.update?.();
    }
  }, [camera, controls, center, radius, token]);

  return null;
}

// The actual three.js scene contents: instanced tunnel blocks, two
// emissive TL endpoint markers, a dashed straight-line reference, a
// floor grid, and a small axis gizmo.
//
// Kept separate from `TunnelViewer3D` so the controls/camera plumbing
// stays terse.

import { useEffect, useMemo, useRef } from "react";
import {
  GizmoHelper,
  GizmoViewport,
  Grid,
  Html,
  Instance,
  Instances,
  Line,
  OrbitControls,
} from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { Color, Vector3 } from "three";

import type { Block3 } from "@/lib/tunnel-share";
import { TUNNEL_MAX_BLOCKS, type PathBlock } from "@/lib/tunnel-pattern";
import { useTranslation } from "@/lib/i18n";

import { CompassTracker, type CompassRefs } from "./CompassOverlay";

interface TunnelSceneProps {
  path: PathBlock[];
  from: Block3;
  to: Block3;
  /** Geometric centre of the path bounds; the camera frames around this. */
  center: [number, number, number];
  /** Half-extent of the path bounds; used to choose orbit distance. */
  radius: number;
  compassRefs: CompassRefs;
  /** Bumped whenever the user wants the camera reset to the auto-frame. */
  recenterToken: number;
}

const BLOCK_COLOR = "#7c7c7c";
const TL_FROM_COLOR = "#3b82f6";
const TL_TO_COLOR = "#f97316";

/** Cap visible voxels so a 50k-block path doesn't melt the GPU; stats
 *  still reflect the full path. */
function clampPath(path: PathBlock[]): PathBlock[] {
  if (path.length <= TUNNEL_MAX_BLOCKS) return path;
  return path.slice(0, TUNNEL_MAX_BLOCKS);
}

export function TunnelScene({
  path,
  from,
  to,
  center,
  radius,
  compassRefs,
  recenterToken,
}: TunnelSceneProps) {
  const { t } = useTranslation();
  const visible = useMemo(() => clampPath(path), [path]);

  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[80, 120, 60]} intensity={0.9} />
      <directionalLight position={[-60, 40, -80]} intensity={0.35} />

      {/* <Grid
        args={[200, 200]}
        position={[center[0], from.y - 0.5, center[2]]}
        cellSize={1}
        cellThickness={0.5}
        cellColor="#3a3a3a"
        sectionSize={16}
        sectionThickness={1}
        sectionColor="#5a5a5a"
        fadeDistance={Math.max(80, radius * 4)}
        fadeStrength={1}
        infiniteGrid
      /> */}

      <TunnelBlocks blocks={visible} />

      <EndpointMarker
        position={[from.x + 0.5, from.y + 0.5, from.z + 0.5]}
        color={TL_FROM_COLOR}
        label={t("tools.tunnel.startTlMarker")}
        coords={from}
      />
      <EndpointMarker
        position={[to.x + 0.5, to.y + 0.5, to.z + 0.5]}
        color={TL_TO_COLOR}
        label={t("tools.tunnel.endTlMarker")}
        coords={to}
      />

      <Line
        points={[
          [from.x + 0.5, from.y + 0.5, from.z + 0.5],
          [to.x + 0.5, to.y + 0.5, to.z + 0.5],
        ]}
        color="#ffffff"
        lineWidth={1}
        dashed
        dashSize={0.6}
        gapSize={0.4}
        transparent
        opacity={0.55}
      />

      <CompassTracker refs={compassRefs} />
      <CameraFramer center={center} radius={radius} token={recenterToken} />

      <OrbitControls makeDefault enableDamping dampingFactor={0.1} />

      <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
        <GizmoViewport axisColors={["#ef4444", "#22c55e", "#3b82f6"]} labelColor="white" />
      </GizmoHelper>
    </>
  );
}

function TunnelBlocks({ blocks }: { blocks: PathBlock[] }) {
  if (blocks.length === 0) return null;
  // Split full blocks vs. slabs so each group can use a single shared
  // geometry — `Instances` doesn't allow per-instance scale.
  const fullBlocks: PathBlock[] = [];
  const slabBlocks: PathBlock[] = [];
  for (const b of blocks) {
    if (b.slab) slabBlocks.push(b);
    else fullBlocks.push(b);
  }
  return (
    <>
      {fullBlocks.length > 0 && (
        // `limit` sizes drei's internal matrix buffer **once on mount** — if
        // the path later grows past the initial `blocks.length`, the extra
        // instances silently disappear. Pin to the hard cap so the buffer is
        // always big enough; `range` still controls how many actually draw.
        <Instances limit={TUNNEL_MAX_BLOCKS} range={fullBlocks.length}>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color={new Color(BLOCK_COLOR)} roughness={0.85} metalness={0.05} />
          {fullBlocks.map((b, i) => (
            <Instance key={i} position={[b.x + 0.5, b.y + 0.5, b.z + 0.5]} />
          ))}
        </Instances>
      )}
      {slabBlocks.length > 0 && (
        <Instances limit={TUNNEL_MAX_BLOCKS} range={slabBlocks.length}>
          <boxGeometry args={[1, 0.5, 1]} />
          <meshStandardMaterial color={new Color(BLOCK_COLOR)} roughness={0.85} metalness={0.05} />
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
}: {
  position: [number, number, number];
  color: string;
  label: string;
  coords: Block3;
}) {
  return (
    <group position={position}>
      <mesh>
        <boxGeometry args={[1.05, 1.05, 1.05]} />
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

/** Snap the camera to a sensible orbit distance whenever the
 *  recenterToken changes (initial mount, "Recenter" click, or path
 *  bounds change beyond a threshold). Also re-frames the first time
 *  OrbitControls becomes available — without that the initial frame
 *  fires before controls mount, OrbitControls then initialises its
 *  `target` to (0,0,0), and the camera ends up looking at the origin
 *  instead of the path. */
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

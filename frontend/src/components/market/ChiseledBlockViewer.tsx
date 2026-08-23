// 3D viewer for a chiseled/microblock design. Heavy module — three.js,
// react-three-fiber, drei — so it's lazy-imported by MarketItemPage to keep the
// main bundle thin. Default-exported so React.lazy works.
//
// Each design is a handful of axis-aligned voxel cuboids (0..16 grid) skinned
// per-material. We don't have the game's texture atlas, so every material is a
// solid colour (see chiselColors.ts). Renders as real boxes with orbit controls.

import { useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, OrbitControls } from "@react-three/drei";

import type { ChiselDesign } from "@/models/auction";
import { chiselColor } from "./chiselColors";

interface ChiseledBlockViewerProps {
  design: ChiselDesign;
  /** CSS height of the canvas. Default "18rem". */
  height?: string;
}

const V = 16; // voxels per block

/** One box mesh, positioned/scaled in block units relative to the model centre. */
function Boxes({ design }: { design: ChiselDesign }) {
  const meshes = useMemo(() => {
    const boxes = design.boxes;
    // Encompassing bounds so we can centre the model at the origin.
    let minX = V,
      minY = V,
      minZ = V,
      maxX = 0,
      maxY = 0,
      maxZ = 0;
    for (const b of boxes) {
      minX = Math.min(minX, b.x0);
      minY = Math.min(minY, b.y0);
      minZ = Math.min(minZ, b.z0);
      maxX = Math.max(maxX, b.x1);
      maxY = Math.max(maxY, b.y1);
      maxZ = Math.max(maxZ, b.z1);
    }
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const midZ = (minZ + maxZ) / 2;

    return boxes.map((b, i) => {
      const w = (b.x1 - b.x0) / V;
      const h = (b.y1 - b.y0) / V;
      const d = (b.z1 - b.z0) / V;
      const px = ((b.x0 + b.x1) / 2 - midX) / V;
      const py = ((b.y0 + b.y1) / 2 - midY) / V;
      const pz = ((b.z0 + b.z1) / 2 - midZ) / V;
      const color = chiselColor(design.materials[b.mat]);
      return { key: i, position: [px, py, pz] as const, scale: [w, h, d] as const, color };
    });
  }, [design]);

  return (
    <group rotation={[0, (design.rotationY * Math.PI) / 180, 0]}>
      {meshes.map((m) => (
        <mesh key={m.key} position={m.position} scale={m.scale} castShadow receiveShadow>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color={m.color} roughness={0.85} metalness={0.05} />
        </mesh>
      ))}
    </group>
  );
}

export default function ChiseledBlockViewer({
  design,
  height = "18rem",
}: ChiseledBlockViewerProps) {
  return (
    <div className="w-full overflow-hidden rounded-md border bg-muted/30" style={{ height }}>
      <Canvas camera={{ position: [1.1, 0.9, 1.4], fov: 40 }} shadows dpr={[1, 2]}>
        <ambientLight intensity={0.7} />
        <directionalLight position={[3, 5, 2]} intensity={1.1} castShadow />
        <directionalLight position={[-3, 2, -2]} intensity={0.4} />
        <Boxes design={design} />
        <OrbitControls
          enablePan={false}
          autoRotate
          autoRotateSpeed={0.8}
          minDistance={0.9}
          maxDistance={4}
        />
        <GizmoHelper alignment="bottom-right" margin={[52, 52]}>
          <GizmoViewport axisColors={["#d4574f", "#5c9e63", "#4c74d4"]} labelColor="#e6e6e6" />
        </GizmoHelper>
      </Canvas>
    </div>
  );
}

// Compass overlay split in two pieces:
//
// - `CompassLabels`: HTML siblings of the <Canvas>, rendered in CSS pixels.
//   Mutated imperatively each frame.
// - `CompassTracker`: a no-render R3F component that runs inside <Canvas>,
//   reads the live camera, and writes positions onto the labels via refs.
//
// Vintage Story world axes inside the scene:
//   +X = east, -X = west
//   +Z = south, -Z = north
//   +Y = up

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";

import { useTranslation } from "@/lib/i18n";

export type CompassDirKey = "north" | "south" | "east" | "west";

export const COMPASS_DIRS: Array<{ key: CompassDirKey; vec: [number, number, number] }> = [
  { key: "north", vec: [0, 0, -1] },
  { key: "south", vec: [0, 0, 1] },
  { key: "east", vec: [1, 0, 0] },
  { key: "west", vec: [-1, 0, 0] },
];

export interface CompassRefs {
  north: React.RefObject<HTMLDivElement | null>;
  south: React.RefObject<HTMLDivElement | null>;
  east: React.RefObject<HTMLDivElement | null>;
  west: React.RefObject<HTMLDivElement | null>;
}

export function useCompassRefs(): CompassRefs {
  return {
    north: useRef<HTMLDivElement | null>(null),
    south: useRef<HTMLDivElement | null>(null),
    east: useRef<HTMLDivElement | null>(null),
    west: useRef<HTMLDivElement | null>(null),
  };
}

/** DOM siblings of the canvas. Their parent must be `relative`. */
export function CompassLabels({ refs }: { refs: CompassRefs }) {
  const { t } = useTranslation();
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {COMPASS_DIRS.map((d) => (
        <div
          key={d.key}
          ref={refs[d.key]}
          className="absolute -translate-x-1/2 -translate-y-1/2 select-none rounded bg-background/80 px-1.5 py-0.5 font-mono text-xs font-bold text-foreground shadow ring-1 ring-foreground/10 backdrop-blur-sm"
          style={{ left: 0, top: 0, opacity: 0 }}
        >
          {t(`tools.tunnel.compass.${d.key}` as const)}
        </div>
      ))}
    </div>
  );
}

/** Inside <Canvas>: each frame, project unit cardinals through the
 *  active camera and write screen coords onto the label refs. */
export function CompassTracker({ refs }: { refs: CompassRefs }) {
  const { camera, size } = useThree();
  const tmp = useRef(new Vector3());

  useFrame(() => {
    for (const d of COMPASS_DIRS) {
      const el = refs[d.key].current;
      if (!el) continue;
      // Place a virtual point 50 units in front of the camera in
      // world space, offset by the cardinal direction. Project to
      // NDC and convert to CSS pixels.
      tmp.current.set(d.vec[0], d.vec[1], d.vec[2]);
      const target = camera.position.clone().add(tmp.current.clone().multiplyScalar(50));
      target.project(camera);
      const behind = target.z > 1 || target.z < -1;
      const x = (target.x * 0.5 + 0.5) * size.width;
      const y = (-target.y * 0.5 + 0.5) * size.height;
      const margin = 16;
      const cx = Math.max(margin, Math.min(size.width - margin, x));
      const cy = Math.max(margin, Math.min(size.height - margin, y));
      el.style.left = `${cx}px`;
      el.style.top = `${cy}px`;
      el.style.opacity = behind ? "0.3" : "0.95";
    }
  });

  return null;
}

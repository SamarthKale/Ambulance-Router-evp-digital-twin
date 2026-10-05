/**
 * The OFF ghost: a translucent ambulance where the same mission, replayed with normal signals
 * and the autopilot, is at this moment (backend: simulation/ghost.py). Interpolated between
 * ticks like the traffic; hidden while there is no ghost pose.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { Group, Material } from "three";

import { useAsset } from "../assets/loader";
import {
  interpolationAlpha,
  lerp,
  lerpAngleDeg,
  sumoAngleToYaw,
  sumoToWorld,
  type Origin,
} from "../simulation/coords";
import { TICK_MS, useSim } from "../simulation/state";
import { Label } from "./Label";

const OPACITY = 0.35;
export const GHOST_COLOR = "#93c5fd";

export function Ghost({ origin }: { origin: Origin }) {
  const asset = useAsset("ambulance");
  const group = useRef<Group>(null);
  const materials = useMemo(
    () =>
      asset.parts.map((part) => {
        const m = (part.material as Material).clone() as Material & { color?: { set: (c: string) => void } };
        m.transparent = true;
        m.opacity = OPACITY;
        m.depthWrite = false;
        m.color?.set(GHOST_COLOR);
        return m;
      }),
    [asset],
  );
  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials]);
  const roof = asset.box.max[1];

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const { prev, curr } = useSim.getState();
    const now = curr?.msg.ghost?.pose;
    g.visible = now != null;
    if (!now || !curr) return;
    const before = prev?.msg.ghost?.pose ?? now;
    const a = interpolationAlpha(performance.now(), curr.receivedAt, TICK_MS);
    const [x, , z] = sumoToWorld(lerp(before.x, now.x, a), lerp(before.y, now.y, a), origin);
    g.position.set(x, 0, z);
    g.rotation.y = sumoAngleToYaw(lerpAngleDeg(before.angle, now.angle, a));
  });

  return (
    <group ref={group} visible={false} name="OFF ghost">
      {asset.parts.map((part, i) => (
        <mesh key={i} geometry={part.geometry} material={materials[i]} renderOrder={5} />
      ))}
      <Label text="OFF ghost" position={[0, roof + 2.2, 0]} background="#1e3a8a" />
    </group>
  );
}

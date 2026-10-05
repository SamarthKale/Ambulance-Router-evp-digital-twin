/**
 * The ambulance: the delivered model at its interpolated pose, a flashing light bar and a
 * red/blue glow while it is on a mission. The model has no `siren` part, so the light bar is
 * the generated stand-in from the asset pipeline (missing part -> fallback).
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Group, MeshStandardMaterial, PointLight } from "three";

import { useAsset } from "../assets/loader";
import { livePoses } from "../simulation/poses";
import { AMBULANCE_ID, useSim } from "../simulation/state";

const FLASH_HZ = 2;
const GLOW = 45;

export function Ambulance() {
  const asset = useAsset("ambulance");
  const group = useRef<Group>(null);
  const glow = useRef<PointLight>(null);
  const sirens = useMemo(
    () =>
      asset.parts
        .filter((p) => p.name === "siren" || p.name?.startsWith("siren_"))
        .map((p) => p.material as MeshStandardMaterial),
    [asset],
  );
  const roof = asset.box.max[1];

  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    const pose = livePoses.byId.get(AMBULANCE_ID);
    g.visible = pose !== undefined;
    if (!pose) return;
    g.position.set(pose.x, 0, pose.z);
    g.rotation.y = pose.yaw;
    const status = useSim.getState().curr?.msg.ambulance.status;
    const active = status === "driving" || status === "pending";
    const phase = Math.floor(clock.elapsedTime * FLASH_HZ * 2) % 2;
    sirens.forEach((m, i) => {
      m.emissive.copy(m.color);
      m.emissiveIntensity = active ? (i % 2 === phase ? 3 : 0.05) : 0;
    });
    if (glow.current) {
      // intensity, not visibility: a light appearing or vanishing recompiles every shader
      glow.current.intensity = active ? GLOW : 0;
      glow.current.color.set(phase ? "#3b82f6" : "#ef4444");
    }
  });

  return (
    <group ref={group} visible={false}>
      {asset.parts.map((part, i) => (
        <mesh key={i} geometry={part.geometry} material={part.material} />
      ))}
      <pointLight ref={glow} position={[0, roof + 1.2, 0.5]} intensity={0} distance={24} decay={1.4} />
    </group>
  );
}

/**
 * Background traffic, instanced: one InstancedMesh per model part, so ~500 vehicles cost a
 * handful of draw calls instead of one per vehicle (Sprint 4 measured ~957 draws at 4x4 1.5x).
 * Vehicles outside the view are skipped; distant ones are drawn as painted boxes (lod.ts).
 */
import { useFrame } from "@react-three/fiber";
import { useCallback, useRef, useState } from "react";
import { Color } from "three";

import { placeholderOf, useAsset } from "../assets/loader";
import { CAR_PAINT, MANIFEST, VEHICLE_VARIANTS, type AssetKey } from "../assets/manifest";
import { livePoses } from "../simulation/poses";
import { AMBULANCE_ID } from "../simulation/state";
import { useInstancedAsset, type InstancedAsset } from "./Asset";
import { VEHICLE_MIN_PX, screen } from "./lod";

/** Every model background traffic can show (vType ids, plus their visual variants). */
export const TRAFFIC_KEYS: AssetKey[] = ["car_sedan", "taxi", "suv", "car_hatchback", "truck", "bus"];
const FALLBACK_KEY: AssetKey = "car_sedan";
const START_CAPACITY = 128;

/** Stable hash of a vehicle id in [0, 1). */
export function hashUnit(id: string, salt = 0): number {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/** The model a vehicle is drawn with: its vType, or a variant of it, picked by its id. */
export function modelFor(type: string, id: string): AssetKey {
  const variants = VEHICLE_VARIANTS[type];
  if (variants) {
    let r = hashUnit(id) * variants.reduce((s, v) => s + v.weight, 0);
    for (const v of variants) {
      r -= v.weight;
      if (r <= 0) return v.key;
    }
    return variants[variants.length - 1]!.key;
  }
  return type in MANIFEST && TRAFFIC_KEYS.includes(type as AssetKey) ? (type as AssetKey) : FALLBACK_KEY;
}

const PAINTS = CAR_PAINT.map((c) => new Color(c));
const BODY: Partial<Record<AssetKey, Color>> = Object.fromEntries(
  TRAFFIC_KEYS.map((k) => [k, new Color(MANIFEST[k].placeholder.color)]),
);
const TINTED = new Set(TRAFFIC_KEYS.filter((k) => "tintMaterials" in MANIFEST[k]));

interface Layers {
  near: InstancedAsset;
  far: InstancedAsset;
}

export function TrafficVehicles() {
  const layers = useRef(new Map<AssetKey, Layers>());
  const [capacity, setCapacity] = useState<Record<string, number>>({});
  const nearCount = useRef(new Map<AssetKey, number>());
  const farCount = useRef(new Map<AssetKey, number>());

  const register = useCallback((key: AssetKey, l: Layers | null) => {
    if (l) layers.current.set(key, l);
    else layers.current.delete(key);
  }, []);

  useFrame(() => {
    nearCount.current.clear();
    farCount.current.clear();
    for (const pose of livePoses.list) {
      if (pose.id === AMBULANCE_ID) continue;
      const key = modelFor(pose.type, pose.id);
      const l = layers.current.get(key);
      if (!l) continue;
      const [w, h, len] = MANIFEST[key].placeholder.size;
      const px = screen.pixels(pose.x, h / 2, pose.z, Math.hypot(w, h, len) / 2);
      if (px < 0) continue; // outside the view
      const near = px >= VEHICLE_MIN_PX;
      const counts = near ? nearCount.current : farCount.current;
      const layer = near ? l.near : l.far;
      const i = counts.get(key) ?? 0;
      counts.set(key, i + 1);
      if (i >= layer.capacity) continue;
      layer.setTransform(i, pose.x, 0, pose.z, pose.yaw);
      // car paint for tinted models (and their boxes); a distant box of any other car
      // takes that model's colour
      if (TINTED.has(key)) layer.setPaint(i, PAINTS[Math.floor(hashUnit(pose.id, 7) * PAINTS.length)]!);
      else if (!near) layer.setPaint(i, BODY[key]!);
    }
    for (const [key, l] of layers.current) {
      const n = nearCount.current.get(key) ?? 0;
      const f = farCount.current.get(key) ?? 0;
      l.near.commit(n);
      l.far.commit(f);
      const needed = Math.max(n, f);
      if (needed > l.near.capacity) {
        // grow (rare): the next render rebuilds this layer with room to spare
        const next = 2 ** Math.ceil(Math.log2(needed * 1.25));
        setCapacity((c) => ((c[key] ?? START_CAPACITY) >= next ? c : { ...c, [key]: next }));
      }
    }
  });

  return (
    <>
      {TRAFFIC_KEYS.map((key) => (
        <TrafficLayer key={key} id={key} capacity={capacity[key] ?? START_CAPACITY} register={register} />
      ))}
    </>
  );
}

const NEAR = { dynamic: true } as const;
const FAR = { dynamic: true, paintAll: true } as const;

function TrafficLayer({
  id,
  capacity,
  register,
}: {
  id: AssetKey;
  capacity: number;
  register: (key: AssetKey, layers: Layers | null) => void;
}) {
  const asset = useAsset(id);
  const near = useInstancedAsset(asset, capacity, NEAR);
  const far = useInstancedAsset(placeholderOf(id), capacity, FAR);
  const layers = useRef<Layers>({ near, far });
  layers.current.near = near;
  layers.current.far = far;
  return (
    <group
      name={`traffic:${id}`}
      ref={(g) => {
        register(id, g ? layers.current : null);
      }}
    >
      <primitive object={near} />
      <primitive object={far} />
    </group>
  );
}

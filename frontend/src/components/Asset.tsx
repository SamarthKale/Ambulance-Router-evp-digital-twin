/**
 * Render prepared assets: one copy (<Asset>) or many copies with one draw call per part
 * (InstancedAsset / <StaticInstances>). Models and placeholders render the same way.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import {
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicMaterial,
  type Material,
} from "three";

import { placeholderOf, useAsset } from "../assets/loader";
import type { AssetKey } from "../assets/manifest";
import type { PreparedAsset } from "../assets/prepare";
import type { Placement } from "./cityLayout";
import { CULL_EVERY, lodRule, screen } from "./lod";

/** One copy of a model (placeholder until it has loaded). */
export function Asset({ id, load = true }: { id: AssetKey; load?: boolean }) {
  const asset = useAsset(id, load);
  return (
    <group>
      {asset.parts.map((part, i) => (
        <mesh key={i} geometry={part.geometry} material={part.material} name={part.name ?? undefined} />
      ))}
    </group>
  );
}

interface InstancedOptions {
  /** Copies culled on the CPU or moving: no three.js culling, matrices rewritten often. */
  dynamic?: boolean;
  /** Parts lit per copy (signal lamps): unlit material, one colour per copy. */
  lampParts?: readonly string[];
  /** Every part takes the per-copy colour (placeholder boxes for distant cars). */
  paintAll?: boolean;
}

/**
 * Every copy of one asset: an InstancedMesh per part, all sharing one matrix buffer (and
 * one paint buffer for tinted parts). Draw calls = parts, whatever the number of copies.
 */
export class InstancedAsset extends Group {
  readonly meshes: InstancedMesh[] = [];
  private readonly matrices: InstancedBufferAttribute;
  private readonly paint: InstancedBufferAttribute | null = null;
  private readonly lamps = new Map<string, InstancedBufferAttribute>();
  private readonly owned: Material[] = [];

  constructor(
    readonly asset: PreparedAsset,
    readonly capacity: number,
    private readonly options: InstancedOptions = {},
  ) {
    super();
    this.name = asset.placeholder ? "instanced placeholder" : "instanced model";
    this.matrices = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
    if (options.dynamic) this.matrices.setUsage(DynamicDrawUsage);
    if (options.paintAll || asset.parts.some((p) => p.tint)) {
      this.paint = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
      if (options.dynamic) this.paint.setUsage(DynamicDrawUsage);
    }
    for (const part of asset.parts) {
      let material = part.material;
      let colors: InstancedBufferAttribute | null = null;
      if (part.name && options.lampParts?.includes(part.name)) {
        material = new MeshBasicMaterial({ color: "#ffffff", toneMapped: false });
        colors = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
        this.lamps.set(part.name, colors);
        this.owned.push(material);
      } else if ((part.tint || options.paintAll) && this.paint) {
        material = part.material.clone();
        (material as MeshBasicMaterial).color?.set("#ffffff"); // the per-copy paint is the colour
        colors = this.paint;
        this.owned.push(material);
      }
      const mesh = new InstancedMesh(part.geometry, material, capacity);
      mesh.instanceMatrix = this.matrices;
      if (colors) mesh.instanceColor = colors;
      mesh.count = 0;
      mesh.frustumCulled = !options.dynamic;
      mesh.name = part.name ?? "";
      this.meshes.push(mesh);
      this.add(mesh);
    }
  }

  /** Copy i: position, rotation about Y, uniform scale. Writes the shared buffer directly. */
  setTransform(i: number, x: number, y: number, z: number, yaw: number, scale = 1): void {
    const c = Math.cos(yaw) * scale;
    const s = Math.sin(yaw) * scale;
    const m = this.matrices.array as Float32Array;
    const o = i * 16;
    m[o] = c;
    m[o + 1] = 0;
    m[o + 2] = -s;
    m[o + 3] = 0;
    m[o + 4] = 0;
    m[o + 5] = scale;
    m[o + 6] = 0;
    m[o + 7] = 0;
    m[o + 8] = s;
    m[o + 9] = 0;
    m[o + 10] = c;
    m[o + 11] = 0;
    m[o + 12] = x;
    m[o + 13] = y;
    m[o + 14] = z;
    m[o + 15] = 1;
  }

  setPaint(i: number, color: Color): void {
    this.paint?.setXYZ(i, color.r, color.g, color.b);
  }

  setLamp(part: string, i: number, color: Color): void {
    this.lamps.get(part)?.setXYZ(i, color.r, color.g, color.b);
  }

  /** Lamp colours changed: upload them. */
  commitLamps(): void {
    for (const attr of this.lamps.values()) attr.needsUpdate = true;
  }

  /** Show the first `count` copies (after setTransform/setPaint). */
  commit(count: number): void {
    const n = Math.min(count, this.capacity);
    this.matrices.needsUpdate = true;
    if (this.paint) this.paint.needsUpdate = true;
    this.commitLamps();
    for (const mesh of this.meshes) {
      mesh.count = n;
      if (!this.options.dynamic) {
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
      }
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
    for (const m of this.owned) m.dispose();
  }
}

/** An InstancedAsset owned by a component: rebuilt when the model arrives or capacity grows. */
export function useInstancedAsset(asset: PreparedAsset, capacity: number, options: InstancedOptions = {}) {
  const { dynamic, lampParts, paintAll } = options;
  const instanced = useMemo(
    () => new InstancedAsset(asset, capacity, { dynamic, lampParts, paintAll }),
    [asset, capacity, dynamic, lampParts, paintAll],
  );
  useEffect(() => () => instanced.dispose(), [instanced]);
  return instanced;
}

const CULLED = { dynamic: true } as const;

/**
 * Fixed copies of a model (buildings, trees, street furniture), culled per copy and drawn
 * as the model, the placeholder or not at all depending on their size on screen (lod.ts).
 */
export function StaticInstances({ id, placements }: { id: AssetKey; placements: readonly Placement[] }) {
  const asset = useAsset(id);
  const rule = lodRule(id);
  const farAsset = rule.far === "placeholder" ? placeholderOf(id) : null;
  const n = Math.max(1, placements.length);
  const near = useInstancedAsset(asset, n, CULLED);
  const far = useInstancedAsset(farAsset ?? asset, farAsset ? n : 1, CULLED);
  const bounds = useMemo(() => {
    const [w, h, l] = asset.size;
    const radius = Math.hypot(w, h, l) / 2;
    return placements.map((p) => ({ y: (p.y ?? 0) + (h / 2) * (p.scale ?? 1), r: radius * (p.scale ?? 1) }));
  }, [asset, placements]);

  useFrame(() => {
    // a fresh layer (model just arrived) is culled at once, then every CULL_EVERY frames
    if (near.userData.culled !== undefined && screen.frame % CULL_EVERY !== 0) return;
    near.userData.culled = screen.frame;
    let nNear = 0;
    let nFar = 0;
    placements.forEach((p, i) => {
      const px = screen.pixels(p.x, bounds[i]!.y, p.z, bounds[i]!.r);
      if (px < 0) return;
      const s = p.scale ?? 1;
      if (px >= rule.minPx) near.setTransform(nNear++, p.x, p.y ?? 0, p.z, p.yaw, s);
      else if (farAsset && px >= (rule.hidePx ?? 0)) far.setTransform(nFar++, p.x, p.y ?? 0, p.z, p.yaw, s);
    });
    near.commit(nNear);
    far.commit(farAsset ? nFar : 0);
  });

  return (
    <group name={`props:${id}`}>
      <primitive object={near} />
      {farAsset && <primitive object={far} />}
    </group>
  );
}

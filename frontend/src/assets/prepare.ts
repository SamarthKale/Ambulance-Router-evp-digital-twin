/**
 * Turn a loaded glTF scene into render-ready parts, without touching the delivered file.
 *
 * - Each mesh is baked into model space: node transforms, then the manifest's rotationY,
 *   fit (uniform scale), pivot and offset. CLAUDE.md asks for those corrections "on a child
 *   group"; baking the same matrix into the geometry is equivalent and lets one
 *   InstancedMesh per part draw every copy of a model.
 * - Meshes are merged to cut draw calls (model.glb alone is 688 meshes):
 *   - plain coloured materials (no texture, opaque, not emissive) become one vertex-coloured
 *     mesh per face side
 *   - textured, transparent or glowing materials merge per material
 *   - named parts the code drives (lamps, siren) and per-instance paint stay separate
 * - Parts are matched case-insensitively; the loader strips "." and Blender appends ".001".
 */
import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  Matrix4,
  MeshStandardMaterial,
  Vector3,
  type Material,
  type Mesh,
  type Object3D,
  type Side,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { AssetEntry, Size3 } from "./manifest";
import { matchPart, normalizeName } from "./names";

export interface PreparedPart {
  /** A driven part (lamp_red, siren_left...) or null for plain model geometry. */
  name: string | null;
  geometry: BufferGeometry;
  material: Material;
  /** Recoloured per instance (car paint). */
  tint: boolean;
  triangles: number;
}

export interface PreparedAsset {
  parts: PreparedPart[];
  /** Fitted bounding-box size: width (x), height (y), length (z), metres. */
  size: Size3;
  /** Fitted bounding box min/max, for placing generated parts. */
  box: { min: [number, number, number]; max: [number, number, number] };
  triangles: number;
  /** Meshes in the file, i.e. draw calls per copy before merging. */
  sourceMeshes: number;
  foundParts: string[];
  missingParts: string[];
  nodeNames: string[];
  placeholder: boolean;
}

export { matchPart, normalizeName };

const FLAT_ROUGHNESS = 0.85;
const flatMaterials = new Map<Side, MeshStandardMaterial>();

/** One shared vertex-coloured material per face side for every plain-coloured mesh. */
export function flatMaterial(side: Side): MeshStandardMaterial {
  let material = flatMaterials.get(side);
  if (!material) {
    material = new MeshStandardMaterial({
      vertexColors: true,
      roughness: FLAT_ROUGHNESS,
      metalness: 0.05,
      side,
    });
    material.name = side === DoubleSide ? "flat (double-sided)" : "flat";
    flatMaterials.set(side, material);
  }
  return material;
}

interface Source {
  geometry: BufferGeometry;
  material: Material;
  part: string | null;
}

function hasTexture(material: Material): boolean {
  return Object.values(material).some(
    (value) => typeof value === "object" && value !== null && (value as { isTexture?: boolean }).isTexture,
  );
}

function isPlain(material: Material): material is MeshStandardMaterial {
  const m = material as MeshStandardMaterial;
  if (!m.isMeshStandardMaterial || hasTexture(m)) return false;
  if (m.transparent || m.alphaTest > 0 || m.opacity < 1) return false;
  return !m.emissive || (m.emissive.r + m.emissive.g + m.emissive.b) * m.emissiveIntensity < 0.01;
}

/** A float32, non-interleaved, non-normalised copy (quantized glTF stores Int16 positions). */
function floatAttribute(attr: BufferAttribute | import("three").InterleavedBufferAttribute): BufferAttribute {
  const size = attr.itemSize;
  const out = new Float32Array(attr.count * size);
  for (let i = 0; i < attr.count; i++) {
    out[i * size] = attr.getX(i);
    if (size > 1) out[i * size + 1] = attr.getY(i);
    if (size > 2) out[i * size + 2] = attr.getZ(i);
    if (size > 3) out[i * size + 3] = attr.getW(i);
  }
  return new Float32BufferAttribute(out, size);
}

const SKIPPED_ATTRIBUTES = new Set(["skinIndex", "skinWeight", "color_1", "_color_1"]);

function bakedCopy(mesh: Mesh, matrix: Matrix4): BufferGeometry {
  const source = mesh.geometry;
  const geometry = new BufferGeometry();
  for (const [name, attr] of Object.entries(source.attributes)) {
    if (!SKIPPED_ATTRIBUTES.has(name)) geometry.setAttribute(name, floatAttribute(attr));
  }
  if (source.index) geometry.setIndex(Array.from(source.index.array as ArrayLike<number>));
  geometry.applyMatrix4(matrix);
  if (matrix.determinant() < 0) flipWinding(geometry); // mirrored node
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  return geometry;
}

function flipWinding(geometry: BufferGeometry): void {
  if (!geometry.index) {
    const n = geometry.getAttribute("position").count;
    geometry.setIndex(Array.from({ length: n }, (_, i) => i));
  }
  const index = geometry.index!.array as Uint32Array | Uint16Array | number[];
  for (let i = 0; i + 2 < index.length; i += 3) {
    const t = index[i + 1]!;
    index[i + 1] = index[i + 2]!;
    index[i + 2] = t;
  }
  geometry.index!.needsUpdate = true;
}

function triangles(geometry: BufferGeometry): number {
  return Math.floor((geometry.index?.count ?? geometry.getAttribute("position").count) / 3);
}

/** Merge geometries that may differ in attributes or indexing: keep what all share. */
function mergeAll(geometries: BufferGeometry[], keep?: Set<string>): BufferGeometry {
  if (geometries.length === 1 && !keep) return geometries[0]!;
  let names = Object.keys(geometries[0]!.attributes);
  for (const g of geometries) names = names.filter((n) => n in g.attributes);
  if (keep) names = names.filter((n) => keep.has(n));
  const indexed = geometries.some((g) => g.index);
  const prepared = geometries.map((g) => {
    const copy = new BufferGeometry();
    for (const n of names) copy.setAttribute(n, g.getAttribute(n));
    if (g.index) copy.setIndex(g.index);
    else if (indexed) copy.setIndex(Array.from({ length: g.getAttribute("position").count }, (_, i) => i));
    return copy;
  });
  const merged = mergeGeometries(prepared, false);
  if (!merged) throw new Error(`could not merge ${geometries.length} meshes`);
  return merged;
}

function withColor(geometry: BufferGeometry, color: Color, vertexColors: boolean): BufferGeometry {
  const n = geometry.getAttribute("position").count;
  const existing = vertexColors ? geometry.getAttribute("color") : undefined;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = existing ? 1 : 0;
    out[i * 3] = color.r * (k ? existing!.getX(i) : 1);
    out[i * 3 + 1] = color.g * (k ? existing!.getY(i) : 1);
    out[i * 3 + 2] = color.b * (k ? existing!.getZ(i) : 1);
  }
  geometry.setAttribute("color", new Float32BufferAttribute(out, 3));
  return geometry;
}

const cutouts = new WeakMap<Material, Material>();

/** Foliage drawn as cut-outs instead of alpha blending (manifest alphaCutout). */
function cutout(material: Material, entry: AssetEntry): Material {
  if (!entry.alphaCutout || !material.transparent) return material;
  let copy = cutouts.get(material);
  if (!copy) {
    copy = material.clone();
    copy.transparent = false;
    copy.depthWrite = true;
    copy.alphaTest = 0.5;
    cutouts.set(material, copy);
  }
  return copy;
}

function nameChain(object: Object3D): string[] {
  const names: string[] = [];
  for (let o: Object3D | null = object; o; o = o.parent) if (o.name) names.push(o.name);
  return names;
}

function assetMatrix(entry: AssetEntry, box: Box3, rotated: Matrix4): Matrix4 {
  const size = box.getSize(new Vector3());
  let scale = entry.scale ?? 1;
  if (entry.fit) {
    const measured = size[entry.fit.axis];
    if (measured > 0) scale = entry.fit.meters / measured;
  }
  const pivot = new Vector3();
  if (entry.pivot === "bottom-center") {
    pivot.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  }
  const [ox, oy, oz] = entry.offset ?? [0, 0, 0];
  return new Matrix4()
    .makeTranslation(ox, oy, oz)
    .multiply(new Matrix4().makeScale(scale, scale, scale))
    .multiply(new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z))
    .multiply(rotated);
}

/** Bake and merge a loaded scene. Throws if it contains no mesh. */
export function prepareScene(root: Object3D, entry: AssetEntry): PreparedAsset {
  root.updateMatrixWorld(true);
  const toRoot = new Matrix4().copy(root.matrixWorld).invert();
  const rotation = new Matrix4().makeRotationY(entry.rotationY ?? 0);
  const driven = [...(entry.requiredParts ?? []), ...(entry.optionalParts ?? [])];
  const hidden = new Set((entry.hide ?? []).map(normalizeName));
  const nodeNames: string[] = [];
  const sources: Source[] = [];
  const found = new Set<string>();

  root.traverse((object) => {
    if (object !== root && object.name) nodeNames.push(object.name);
    const mesh = object as Mesh;
    if (!mesh.isMesh || !mesh.geometry?.getAttribute("position")) return;
    const chain = nameChain(mesh);
    if (chain.some((n) => hidden.has(normalizeName(n)))) return;
    let part: string | null = null;
    for (const n of chain) {
      part = matchPart(n, driven, entry.aliases);
      if (part) break;
    }
    if (part) found.add(part);
    const matrix = rotation.clone().multiply(toRoot.clone().multiply(mesh.matrixWorld));
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    sources.push({ geometry: bakedCopy(mesh, matrix), material: cutout(materials[0]!, entry), part });
  });
  if (sources.length === 0) throw new Error("the file contains no mesh");

  const box = new Box3();
  for (const s of sources) {
    s.geometry.computeBoundingBox();
    box.union(s.geometry.boundingBox!);
  }
  const fitted = assetMatrix(entry, box, new Matrix4());
  for (const s of sources) s.geometry.applyMatrix4(fitted);

  const tintNames = new Set<string>(entry.tintMaterials ?? []);
  const groups = new Map<string, { sources: Source[]; part: string | null; tint: boolean; plain: boolean }>();
  for (const s of sources) {
    const tint = !s.part && tintNames.has(s.material.name);
    const plain = !s.part && !tint && isPlain(s.material);
    const key = s.part
      ? `part:${s.part}:${s.material.uuid}`
      : plain
        ? `flat:${s.material.side}`
        : `${tint ? "tint" : "mat"}:${s.material.uuid}`;
    const group = groups.get(key) ?? { sources: [], part: s.part, tint, plain };
    group.sources.push(s);
    groups.set(key, group);
  }

  const parts: PreparedPart[] = [];
  for (const group of groups.values()) {
    if (group.plain) {
      const colored = group.sources.map((s) => {
        const m = s.material as MeshStandardMaterial;
        return withColor(s.geometry, m.color, m.vertexColors);
      });
      const geometry = mergeAll(colored, new Set(["position", "normal", "color"]));
      const side = group.sources[0]!.material.side === DoubleSide ? DoubleSide : FrontSide;
      parts.push({ name: null, geometry, material: flatMaterial(side), tint: false, triangles: triangles(geometry) });
    } else {
      const geometry = mergeAll(group.sources.map((s) => s.geometry));
      const material = group.sources[0]!.material;
      parts.push({ name: group.part, geometry, material, tint: group.tint, triangles: triangles(geometry) });
    }
  }

  const fittedBox = new Box3();
  for (const p of parts) {
    p.geometry.computeBoundingBox();
    p.geometry.computeBoundingSphere();
    fittedBox.union(p.geometry.boundingBox!);
  }
  const size = fittedBox.getSize(new Vector3());
  return {
    parts,
    size: [size.x, size.y, size.z],
    box: { min: fittedBox.min.toArray(), max: fittedBox.max.toArray() },
    triangles: parts.reduce((n, p) => n + p.triangles, 0),
    sourceMeshes: sources.length,
    foundParts: [...found],
    missingParts: (entry.requiredParts ?? []).filter((p) => !found.has(p)),
    nodeNames,
    placeholder: false,
  };
}

const LAMP_COLORS: Record<string, string> = {
  lamp_red: "#ef4444",
  lamp_yellow: "#facc15",
  lamp_green: "#22c55e",
};

function placed(geometry: BufferGeometry, x: number, y: number, z: number): BufferGeometry {
  geometry.translate(x, y, z);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Generated stand-ins for driven parts a model lacks (or for a placeholder): lamp discs on
 * the front of the head, a red/blue light bar on the roof.
 */
export function fallbackParts(entry: AssetEntry, asset: Pick<PreparedAsset, "box" | "size">): PreparedPart[] {
  const parts: PreparedPart[] = [];
  const [minX, , minZ] = asset.box.min;
  const [maxX, maxY, maxZ] = asset.box.max;
  const missing = (entry.requiredParts ?? []).filter((p) => p.startsWith("lamp_") || p === "siren");
  const lamps = missing.filter((p) => p.startsWith("lamp_"));
  lamps.forEach((name, i) => {
    const r = 0.13;
    const geometry = placed(new CylinderGeometry(r, r, 0.06, 16).rotateX(Math.PI / 2), maxX - 0.2, maxY - 0.35 - i * 0.37, maxZ + 0.03);
    parts.push({ name, geometry, material: new MeshStandardMaterial({ color: LAMP_COLORS[name] }), tint: false, triangles: triangles(geometry) });
  });
  if (missing.includes("siren")) {
    const width = (maxX - minX) * 0.36;
    const z = minZ + (maxZ - minZ) * 0.62;
    for (const [name, x, color] of [
      ["siren_left", -width / 2, "#ef4444"],
      ["siren_right", width / 2, "#3b82f6"],
    ] as const) {
      const geometry = placed(new BoxGeometry(width * 0.95, 0.22, 0.5), x, maxY + 0.11, z);
      parts.push({ name, geometry, material: new MeshStandardMaterial({ color }), tint: false, triangles: triangles(geometry) });
    }
  }
  return parts;
}

/** The manifest placeholder as a prepared asset (box / cylinder / cone, base on y = 0). */
export function placeholderAsset(entry: AssetEntry): PreparedAsset {
  const [w, h, l] = entry.placeholder.size;
  const shape = entry.placeholder.shape;
  const geometry =
    shape === "box"
      ? new BoxGeometry(w, h, l)
      : shape === "cylinder"
        ? new CylinderGeometry(Math.min(w, l) / 2, Math.min(w, l) / 2, h, 16)
        : new ConeGeometry(Math.max(w, l) / 2, h, 16);
  placed(geometry, 0, h / 2, 0);
  const body: PreparedPart = {
    name: null,
    geometry,
    material: new MeshStandardMaterial({ color: entry.placeholder.color, roughness: 0.8 }),
    tint: false,
    triangles: triangles(geometry),
  };
  const box = { min: [-w / 2, 0, -l / 2] as [number, number, number], max: [w / 2, h, l / 2] as [number, number, number] };
  const extra = fallbackParts(entry, { box, size: [w, h, l] });
  const parts = [body, ...extra];
  return {
    parts,
    size: [w, h, l],
    box,
    triangles: parts.reduce((n, p) => n + p.triangles, 0),
    sourceMeshes: 0,
    foundParts: extra.map((p) => p.name!).filter(Boolean),
    missingParts: [],
    nodeNames: [],
    placeholder: true,
  };
}

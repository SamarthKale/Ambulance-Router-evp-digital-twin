import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Texture,
  Vector3,
  type BufferGeometry,
} from "three";
import { describe, expect, it } from "vitest";

import { MANIFEST, type AssetEntry } from "./manifest";
import { fallbackParts, flatMaterial, matchPart, normalizeName, placeholderAsset, prepareScene } from "./prepare";

const entry = (over: Partial<AssetEntry> = {}): AssetEntry => ({
  file: "test.glb",
  enabled: true,
  owner: "Member 1",
  workbook: null,
  priority: null,
  pivot: "bottom-center",
  placeholder: { size: [1, 1, 1], color: "#fff", shape: "box" },
  triBudget: 5000,
  ...over,
});

function box(w: number, h: number, l: number, color = "#ff0000", name = ""): Mesh {
  const mesh = new Mesh(new BoxGeometry(w, h, l), new MeshStandardMaterial({ color }));
  mesh.name = name;
  return mesh;
}

function bounds(geometry: BufferGeometry) {
  geometry.computeBoundingBox();
  return geometry.boundingBox!;
}

describe("part names", () => {
  it("ignore case, punctuation and Blender's .001 suffix", () => {
    expect(normalizeName("Red_Light.001")).toBe("redlight001");
    const aliases = MANIFEST.traffic_light.aliases;
    const parts = MANIFEST.traffic_light.requiredParts;
    expect(matchPart("Red_Light", parts, aliases)).toBe("lamp_red");
    expect(matchPart("red_light001", parts, aliases)).toBe("lamp_red"); // loader strips the "."
    expect(matchPart("LAMP_GREEN", parts, aliases)).toBe("lamp_green");
    expect(matchPart("TrafficLight_Pole", parts, aliases)).toBeNull();
  });
});

describe("prepareScene", () => {
  it("fits, pivots to the bottom centre and bakes node transforms", () => {
    const root = new Group();
    const body = box(2, 1, 4);
    body.position.set(10, 5, -3); // offset in the file
    body.scale.setScalar(0.5);
    root.add(body);
    const asset = prepareScene(root, entry({ fit: { axis: "z", meters: 6 } }));
    expect(asset.size[2]).toBeCloseTo(6);
    expect(asset.size[0]).toBeCloseTo(3); // uniform scale keeps the proportions
    const b = bounds(asset.parts[0]!.geometry);
    expect(b.min.y).toBeCloseTo(0);
    expect((b.min.x + b.max.x) / 2).toBeCloseTo(0);
    expect((b.min.z + b.max.z) / 2).toBeCloseTo(0);
  });

  it("turns the model before fitting, so `fit.axis` is in the corrected frame", () => {
    const root = new Group();
    root.add(box(8, 2, 2)); // modelled along X
    const asset = prepareScene(root, entry({ rotationY: Math.PI / 2, fit: { axis: "z", meters: 4 } }));
    expect(asset.size[2]).toBeCloseTo(4);
    expect(asset.size[0]).toBeCloseTo(1);
  });

  it("merges plain colours into one vertex-coloured mesh and keeps driven parts apart", () => {
    const root = new Group();
    root.add(box(1, 1, 1, "#ff0000", "Housing"), box(1, 1, 1, "#00ff00", "Pole"));
    const lamp = box(0.2, 0.2, 0.1, "#ff0000", "Red_Light.001");
    lamp.position.y = 3;
    root.add(lamp);
    const asset = prepareScene(root, { ...MANIFEST.traffic_light, pivot: "none" });
    expect(asset.sourceMeshes).toBe(3);
    const plain = asset.parts.filter((p) => p.name === null);
    expect(plain).toHaveLength(1);
    expect(plain[0]!.material).toBe(flatMaterial(plain[0]!.material.side));
    expect(plain[0]!.geometry.getAttribute("color")).toBeDefined();
    expect(asset.parts.find((p) => p.name === "lamp_red")).toBeDefined();
    expect(asset.foundParts).toEqual(["lamp_red"]);
    expect(asset.missingParts.sort()).toEqual(["lamp_green", "lamp_yellow"]);
  });

  it("keeps textured or transparent materials as their own parts", () => {
    const root = new Group();
    const textured = new MeshStandardMaterial({ map: new Texture() });
    const glass = new MeshStandardMaterial({ transparent: true, opacity: 0.4 });
    root.add(new Mesh(new BoxGeometry(1, 1, 1), textured), new Mesh(new BoxGeometry(1, 1, 1), glass), box(1, 1, 1));
    const asset = prepareScene(root, entry());
    expect(asset.parts).toHaveLength(3);
    expect(asset.parts.map((p) => p.material)).toContain(textured);
    expect(asset.parts.map((p) => p.material)).toContain(glass);
  });

  it("separates tinted car paint for per-vehicle colours", () => {
    const root = new Group();
    const paint = new MeshStandardMaterial({ color: "#ffffff" });
    paint.name = "White";
    root.add(new Mesh(new BoxGeometry(2, 1, 4), paint), box(0.5, 0.5, 0.5, "#111111"));
    const asset = prepareScene(root, entry({ tintMaterials: ["White"] }));
    expect(asset.parts.filter((p) => p.tint)).toHaveLength(1);
  });

  it("does not render hidden nodes and keeps faces outward under a mirrored node", () => {
    const root = new Group();
    const ground = box(100, 0.1, 100);
    ground.name = "sceneGroundPlane";
    const mirrored = box(1, 1, 1);
    mirrored.scale.set(-1, 1, 1);
    root.add(ground, mirrored);
    const asset = prepareScene(root, entry({ hide: ["sceneGroundPlane"] }));
    expect(asset.size[0]).toBeCloseTo(1);
    // the +X face's triangles still point +X after the mirror
    const g = asset.parts[0]!.geometry;
    const pos = g.getAttribute("position");
    const index = g.getIndex()!.array;
    let outward = 0;
    for (let i = 0; i < index.length; i += 3) {
      const v = (k: number) => new Vector3().fromBufferAttribute(pos, index[i + k]!);
      const [a, b, c] = [v(0), v(1), v(2)];
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      const centre = a.clone().add(b).add(c).divideScalar(3);
      centre.y -= 0.5; // box centre is at y = 0.5 after the pivot
      if (n.dot(centre) > 0) outward += 1;
    }
    expect(outward).toBe(index.length / 3);
  });
});

describe("fallbacks", () => {
  it("adds lamp discs and a light bar for missing driven parts", () => {
    const lampNames = fallbackParts(MANIFEST.traffic_light, placeholderAsset(MANIFEST.traffic_light)).map((p) => p.name);
    expect(lampNames).toEqual(["lamp_red", "lamp_yellow", "lamp_green"]);
    const siren = fallbackParts(MANIFEST.ambulance, placeholderAsset(MANIFEST.ambulance)).map((p) => p.name);
    expect(siren).toEqual(["siren_left", "siren_right"]);
  });

  it("builds every placeholder at its manifest size, standing on the ground", () => {
    for (const key of Object.keys(MANIFEST) as (keyof typeof MANIFEST)[]) {
      const asset = placeholderAsset(MANIFEST[key]);
      expect(asset.placeholder).toBe(true);
      const b = bounds(asset.parts[0]!.geometry);
      expect(b.min.y, key).toBeCloseTo(0);
      expect(b.max.y, key).toBeCloseTo(MANIFEST[key].placeholder.size[1]);
    }
  });
});

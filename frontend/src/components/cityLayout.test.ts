import { describe, expect, it } from "vitest";

import { MANIFEST, type AssetKey } from "../assets/manifest";
import { originFromBounds, sumoToWorld } from "../simulation/coords";
import type { NetworkMsg } from "../simulation/state";
import {
  approachLamp,
  buildCityLayout,
  rectsOverlap,
  yawFacing,
  yawXFacing,
  type Placement,
  type Rect,
} from "./cityLayout";
import grid2x2 from "./fixtures/network.grid2x2.json";
import grid4x4 from "./fixtures/network.grid4x4.json";

const NETWORKS = { grid2x2, grid4x4 } as unknown as Record<string, NetworkMsg>;

const BUILDINGS: AssetKey[] = [
  "building_01", "building_02", "building_03", "building_04", "building_05",
  "residential", "shops", "petrol_station", "hospital",
];
// things that stand on pavements or lots (dividers stand on the centre line by design)
const OFF_ROAD: AssetKey[] = [
  ...BUILDINGS.filter((k) => k !== "hospital"), "tree", "tree_pine", "streetlight", "hydrant", "trashcan", "bench",
  "bus_stop", "pedestrian_signal", "sign_no_parking", "sign_stop", "fuel_pump", "truck",
  "fire_truck", "police_car", "auto_rickshaw", "scooter", "street_tile",
];

function footprint(key: AssetKey, p: Placement): Rect {
  const [w, , l] = MANIFEST[key].placeholder.size;
  const s = p.scale ?? 1;
  const c = Math.abs(Math.cos(p.yaw));
  const n = Math.abs(Math.sin(p.yaw));
  const hx = ((w * c + l * n) * s) / 2; // bounding box of the rotated footprint
  const hz = ((w * n + l * c) * s) / 2;
  return { x0: p.x - hx, z0: p.z - hz, x1: p.x + hx, z1: p.z + hz };
}

/** World rectangles covered by the carriageway (straight grid lanes). */
function laneRects(network: NetworkMsg): Rect[] {
  const origin = originFromBounds(network.bounds);
  return network.lanes.map((lane) => {
    const pts = lane.shape.map(([x, y]) => sumoToWorld(x, y, origin));
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[2]);
    const h = lane.width / 2;
    return { x0: Math.min(...xs) - h, z0: Math.min(...zs) - h, x1: Math.max(...xs) + h, z1: Math.max(...zs) + h };
  });
}

function junctionPolygons(network: NetworkMsg): Map<string, [number, number][]> {
  const origin = originFromBounds(network.bounds);
  return new Map(
    network.junctions.map((j) => [
      j.id,
      j.shape.map(([x, y]) => {
        const [wx, , wz] = sumoToWorld(x, y, origin);
        return [wx, wz] as [number, number];
      }),
    ]),
  );
}

function inPolygon(x: number, z: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

describe.each(Object.keys(NETWORKS))("city layout on %s", (name) => {
  const network = NETWORKS[name]!;
  const layout = buildCityLayout(network);
  const lanes = laneRects(network);

  it("is deterministic", () => {
    expect(JSON.stringify(buildCityLayout(network))).toBe(JSON.stringify(layout));
  });

  it("keeps buildings, furniture and parked vehicles off the carriageway", () => {
    for (const key of OFF_ROAD) {
      for (const p of layout.props[key] ?? []) {
        // a streetlight's arm reaches over the road by design: check its pole; a tree's
        // canopy is round, not its rotated bounding box
        const r = key === "streetlight" ? 0.1 : key.startsWith("tree") ? 1.8 * (p.scale ?? 1) : 0;
        const rect = r > 0 ? { x0: p.x - r, z0: p.z - r, x1: p.x + r, z1: p.z + r } : footprint(key, p);
        const hit = lanes.find((lane) => rectsOverlap(rect, lane, -0.05));
        expect(hit, `${key} at (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`).toBeUndefined();
      }
    }
    expect(layout.hospital).not.toBeNull();
    expect(lanes.some((lane) => rectsOverlap(footprint("hospital", layout.hospital!), lane))).toBe(false);
  });

  it("never overlaps two buildings", () => {
    const rects = BUILDINGS.flatMap((key) => (layout.props[key] ?? []).map((p) => ({ key, rect: footprint(key, p) })));
    if (layout.hospital) rects.push({ key: "hospital", rect: footprint("hospital", layout.hospital) });
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i]!.rect, rects[j]!.rect, -0.01), `${rects[i]!.key} / ${rects[j]!.key}`).toBe(false);
      }
    }
    expect(rects.length).toBeGreaterThan(name === "grid2x2" ? 25 : 100);
  });

  it("puts the hospital by the hospital stop", () => {
    const origin = originFromBounds(network.bounds);
    const [hx, , hz] = sumoToWorld(network.hospital.x, network.hospital.y, origin);
    const h = layout.hospital!;
    expect(Math.hypot(h.x - hx, h.z - hz)).toBeLessThan(70);
  });

  it("gives every signalised approach one head at its stop line, off the road", () => {
    const approaches = network.signals.flatMap((s) => [...new Set(s.links.map((l) => `${s.id}:${l.approach}`))]);
    expect(layout.signalHeads.map((h) => `${h.junction}:${h.approach}`).sort()).toEqual(approaches.sort());
    const origin = originFromBounds(network.bounds);
    for (const head of layout.signalHeads) {
      const lane0 = network.lanes.find((l) => l.edge === head.approach && l.index === 0)!;
      const [ex, ey] = lane0.shape[lane0.shape.length - 1]!;
      const [x, , z] = sumoToWorld(ex, ey, origin);
      expect(Math.hypot(head.placement.x - x, head.placement.z - z)).toBeLessThan(4);
      const pole = { x0: head.placement.x - 0.15, z0: head.placement.z - 0.15, x1: head.placement.x + 0.15, z1: head.placement.z + 0.15 };
      expect(lanes.some((lane) => rectsOverlap(pole, lane))).toBe(false);
      const links = network.signals.find((s) => s.id === head.junction)!.links.filter((l) => l.approach === head.approach);
      expect(head.links.sort()).toEqual(links.map((l) => l.index).sort());
    }
  });

  it("paints the zebra crossings inside the junction box", () => {
    const polys = junctionPolygons(network);
    const tls = network.signals.map((s) => polys.get(s.id)!);
    expect(layout.zebras.length).toBeGreaterThan(0);
    for (const stripe of layout.zebras) {
      expect(tls.some((poly) => inPolygon(stripe.x, stripe.z, poly)), `stripe at ${stripe.x}, ${stripe.z}`).toBe(true);
    }
  });

  it("lays the ground without overlaps or holes (fill rate)", () => {
    const flat = [...layout.ground, ...layout.sidewalks, ...layout.lots.map((l) => l.rect)];
    for (let i = 0; i < flat.length; i++) {
      for (let j = i + 1; j < flat.length; j++) {
        expect(rectsOverlap(flat[i]!, flat[j]!, -0.01), `${i} / ${j}`).toBe(false);
      }
    }
    // everything not covered by a ground layer is carriageway: sample points on a grid
    const { bounds } = layout;
    const junctions = [...junctionPolygons(network).values()].filter((p) => p.length >= 3);
    for (let x = bounds.x0 + 0.5; x < bounds.x1; x += 7.3) {
      for (let z = bounds.z0 + 0.5; z < bounds.z1; z += 7.3) {
        const covered =
          flat.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) ||
          lanes.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) ||
          junctions.some((poly) => inPolygon(x, z, poly));
        expect(covered, `hole at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBe(true);
      }
    }
  });

  it("uses every placed key from the manifest", () => {
    for (const key of Object.keys(layout.props)) expect(MANIFEST).toHaveProperty(key);
  });
});

describe("approach lamp", () => {
  it("shows green when any link of the approach may go, including yield-green", () => {
    expect(approachLamp("rrGGrrrr", [2, 3])).toBe("green");
    expect(approachLamp("rrrgrrrr", [2, 3])).toBe("green");
    expect(approachLamp("rryyrrrr", [2, 3])).toBe("yellow");
    expect(approachLamp("GGrrGGrr", [2, 3])).toBe("red");
    expect(approachLamp("", [2])).toBe("off");
  });
});

describe("yaw helpers", () => {
  it("turns +Z and +X towards a direction", () => {
    const facing = (yaw: number) => [Math.sin(yaw), Math.cos(yaw)];
    const xAxis = (yaw: number) => [Math.cos(yaw), -Math.sin(yaw)];
    for (const d of [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }, { x: 0.6, z: -0.8 }]) {
      const [fx, fz] = facing(yawFacing(d));
      expect(fx).toBeCloseTo(d.x);
      expect(fz).toBeCloseTo(d.z);
      const [xx, xz] = xAxis(yawXFacing(d));
      expect(xx).toBeCloseTo(d.x);
      expect(xz).toBeCloseTo(d.z);
    }
  });
});

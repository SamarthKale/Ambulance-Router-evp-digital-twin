import { Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { originFromBounds } from "../simulation/coords";
import type { NetworkMsg } from "../simulation/state";
import grid2x2 from "./fixtures/network.grid2x2.json";
import { cumulative, distanceAlong, routePolyline, routeRibbon } from "./routePath";

const network = grid2x2 as unknown as NetworkMsg;
const origin = originFromBounds(network.bounds);
const ROUTE = ["w0_A0", "A0_A1", "A1_B1", "B1_e1"];

describe("route path", () => {
  const points = routePolyline(network, origin, ROUTE);
  const along = cumulative(points);

  it("follows the roads end to end, about as long as the route", () => {
    // 189.6 + 229.2 + 229.2 + 189.6 m of road plus ~18 m through each of three junctions
    expect(along[along.length - 1]).toBeGreaterThan(837 + 3 * 10);
    expect(along[along.length - 1]).toBeLessThan(837 + 3 * 25);
    expect(along.every((d, i) => i === 0 || d >= along[i - 1]!)).toBe(true);
  });

  it("joins consecutive roads without gaps", () => {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      expect(Math.hypot(b[0] - a[0], b[2] - a[2])).toBeLessThan(240);
    }
  });

  it("locates a point along the route", () => {
    const start = points[0]!;
    expect(distanceAlong(points, along, start[0], start[2])).toBeCloseTo(0);
    const a1 = points[1]!;
    const mid: [number, number] = [(start[0] + a1[0]) / 2, (start[2] + a1[2]) / 2];
    expect(distanceAlong(points, along, mid[0], mid[1])).toBeCloseTo(along[1]! / 2, 1);
  });

  it("builds an upward ribbon carrying the distance along the route", () => {
    const geometry = routeRibbon(points, 1.6, 0.1);
    expect(geometry.getAttribute("along").count).toBe(points.length * 2);
    const pos = geometry.getAttribute("position");
    const index = Array.from(geometry.getIndex()!.array);
    for (let i = 0; i < index.length; i += 3) {
      const v = (k: number) => new Vector3().fromBufferAttribute(pos, index[i + k]!);
      const n = v(1).sub(v(0)).cross(v(2).sub(v(0)));
      if (n.length() > 1e-9) expect(n.normalize().y).toBeCloseTo(1);
    }
  });

  it("skips unknown roads", () => {
    expect(routePolyline(network, origin, ["nope"])).toEqual([]);
  });
});

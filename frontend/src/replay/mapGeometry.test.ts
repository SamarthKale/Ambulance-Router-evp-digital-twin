import { describe, expect, it } from "vitest";

import { buildGeometry, nearestEdge, nearestJunction, routePolyline } from "./mapGeometry";
import { loadRealNetwork } from "./testData";

const network = loadRealNetwork("grid4x4");
const geometry = buildGeometry(network);

describe("buildGeometry (the real 4x4 network)", () => {
  it("takes every road, lane and junction from the network", () => {
    expect(geometry.lanes).toHaveLength(network.lanes.length);
    expect(geometry.edgeIds).toHaveLength(80);
    expect(geometry.junctions.filter((j) => j.signalised)).toHaveLength(16);
    expect(geometry.signalIds).toHaveLength(16);
    expect(geometry.bounds).toEqual(network.bounds);
  });

  it("has a stop line for each road that ends at a signal, with unit directions", () => {
    expect(geometry.approaches.length).toBeGreaterThanOrEqual(48); // at least 3 per junction
    for (const a of geometry.approaches) {
      expect(Math.hypot(a.dx, a.dy)).toBeCloseTo(1);
      expect(a.links.length).toBeGreaterThan(0);
      expect(geometry.edgeLine.has(a.edge)).toBe(true);
    }
    const a0 = geometry.approachesByJunction.get("A0") ?? [];
    expect(new Set(a0.map((a) => a.edge)).size).toBe(a0.length); // one stop line per road
    expect(a0.length).toBeGreaterThanOrEqual(3);
  });

  it("puts the depot and the hospital where the network says", () => {
    expect(geometry.depot).toMatchObject({ edge: network.depot.edge, x: network.depot.x });
    expect(geometry.hospital).toMatchObject({ edge: network.hospital.edge, y: network.hospital.y });
  });

  it("draws a road at its centreline: the mean of its lanes", () => {
    const line = geometry.edgeLine.get("w0_A0");
    expect(line?.[0][1]).toBeCloseTo(network.depot.y - 1.6, 1); // the depot is in lane 0, 1.6 m from the middle
    expect(geometry.edgeWidth.get("w0_A0")).toBeCloseTo(6.4); // two 3.2 m lanes
  });
});

describe("hit testing", () => {
  it("finds the road under a point and nothing far from any road", () => {
    const [x, y] = geometry.edgeLine.get("w0_A0")?.[0] ?? [0, 0];
    expect(nearestEdge(geometry, x + 20, y, 5)).toBe("w0_A0");
    expect(nearestEdge(geometry, -500, -500, 10)).toBeNull();
  });

  it("finds the nearest signalised junction", () => {
    const j = geometry.junctions.find((q) => q.id === "B1");
    expect(nearestJunction(geometry, (j?.cx ?? 0) + 3, (j?.cy ?? 0) - 2, 20)).toBe("B1");
    expect(nearestJunction(geometry, -500, -500, 20)).toBeNull();
  });

  it("joins the centrelines of a route's roads", () => {
    const route = ["w0_A0", "A0_B0"];
    const line = routePolyline(geometry, route);
    const expected = route.reduce((n, e) => n + (geometry.edgeLine.get(e)?.length ?? 0), 0);
    expect(line).toHaveLength(expected);
    expect(routePolyline(geometry, ["nowhere"])).toEqual([]);
  });
});

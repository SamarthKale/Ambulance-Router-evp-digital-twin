import { Vector3 } from "three";
import { describe, expect, it } from "vitest";

import type { WorldPoint } from "../simulation/coords";
import {
  groundPolygonGeometry,
  rectsGeometry,
  ribbonGeometry,
  stripsGeometry,
  type FlatStrip,
} from "./geometry";

function faceNormals(points: WorldPoint[]): Vector3[] {
  return geometryNormals(ribbonGeometry(points, 3));
}

function geometryNormals(geometry: import("three").BufferGeometry): Vector3[] {
  const pos = geometry.getAttribute("position");
  const index = Array.from(geometry.getIndex()?.array ?? []);
  const v = (i: number) => new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
  const normals: Vector3[] = [];
  for (let i = 0; i < index.length; i += 3) {
    const [a, b, c] = [v(index[i]!), v(index[i + 1]!), v(index[i + 2]!)];
    normals.push(b.clone().sub(a).cross(c.clone().sub(a)).normalize());
  }
  return normals;
}

describe("ribbonGeometry", () => {
  it("builds a flat strip of the given width around a straight lane", () => {
    const geometry = ribbonGeometry(
      [
        [0, 0, 0],
        [10, 0, 0],
      ],
      3,
      0.02,
    );
    const pos = Array.from(geometry.getAttribute("position").array);
    // two vertices per point, offset +-1.5 m across the direction of travel (x)
    expect(pos).toEqual([0, 0.02, 1.5, 0, 0.02, -1.5, 10, 0.02, 1.5, 10, 0.02, -1.5].map(Math.fround));
    expect(geometry.getIndex()?.count).toBe(6); // one quad = two triangles
  });

  it.each([
    ["east", [[0, 0, 0], [10, 0, 0]]],
    ["north", [[0, 0, 0], [0, 0, -10]]],
    ["west, bent", [[0, 0, 0], [-10, 0, 0], [-15, 0, 5]]],
  ] as [string, WorldPoint[]][])("faces up so a camera above sees it (%s)", (_, points) => {
    for (const normal of faceNormals(points)) {
      expect(normal.y).toBeCloseTo(1);
    }
  });
});

describe("generated ground layers face up", () => {
  it("rectangles", () => {
    const geometry = rectsGeometry([{ x0: 0, z0: 0, x1: 5, z1: 2 }, { x0: -3, z0: -9, x1: -1, z1: -4 }], 0.01);
    for (const n of geometryNormals(geometry)) expect(n.y).toBeCloseTo(1);
  });

  it.each([
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
    [0.6, -0.8],
  ])("strips along (%s, %s)", (ux, uz) => {
    const strip: FlatStrip = { x: 3, z: -2, ux, uz, length: 4, width: 0.5 };
    const geometry = stripsGeometry([strip]);
    for (const n of geometryNormals(geometry)) expect(n.y).toBeCloseTo(1);
    const pos = geometry.getAttribute("position");
    const p = (i: number) => new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const sides = [p(0).distanceTo(p(1)), p(1).distanceTo(p(2))].sort();
    expect(sides[0]).toBeCloseTo(0.5);
    expect(sides[1]).toBeCloseTo(4);
    // the long side runs along u
    const long = p(0).distanceTo(p(1)) > 1 ? p(1).sub(p(0)) : p(2).sub(p(1));
    expect(Math.abs(long.normalize().dot(new Vector3(ux, 0, uz)))).toBeCloseTo(1);
  });

  it("polygons (junction shapes)", () => {
    const square: WorldPoint[] = [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]];
    for (const n of geometryNormals(groundPolygonGeometry(square, 0.01))) expect(n.y).toBeCloseTo(1);
    for (const n of geometryNormals(groundPolygonGeometry([...square].reverse(), 0.01))) expect(n.y).toBeCloseTo(1);
  });
});

import { Vector3 } from "three";
import { describe, expect, it } from "vitest";

import type { WorldPoint } from "../simulation/coords";
import { ribbonGeometry } from "./geometry";

function faceNormals(points: WorldPoint[]): Vector3[] {
  const geometry = ribbonGeometry(points, 3);
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

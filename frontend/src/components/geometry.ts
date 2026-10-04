/** Flat geometry generated from the SUMO network (CLAUDE.md section 11: roads are code, not models). */
import { BufferGeometry, Float32BufferAttribute, Shape, ShapeGeometry, Vector2 } from "three";

import type { WorldPoint } from "../simulation/coords";

/** A flat strip of `width` metres centred on a polyline in the XZ plane, facing up (+Y). */
export function ribbonGeometry(points: WorldPoint[], width: number, height = 0): BufferGeometry {
  const half = width / 2;
  const positions: number[] = [];
  const indices: number[] = [];
  points.forEach((p, i) => {
    const a = points[Math.max(0, i - 1)]!;
    const b = points[Math.min(points.length - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dz) || 1;
    const ox = -dz / len; // unit offset across the direction of travel
    const oz = dx / len;
    positions.push(p[0] + ox * half, height, p[2] + oz * half); // vertex 2i
    positions.push(p[0] - ox * half, height, p[2] - oz * half); // vertex 2i + 1
    if (i > 0) {
      const k = 2 * i;
      // Counter-clockwise seen from above, so the faces point up and are not culled.
      indices.push(k - 2, k, k - 1, k - 1, k, k + 1);
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A flat polygon from world points. ShapeGeometry is built in the XY plane, so we feed it
 * (x, -z) and the mesh is rotated -90 deg about X, which maps it back to (x, 0, z).
 */
export function flatPolygonGeometry(points: WorldPoint[]): ShapeGeometry {
  return new ShapeGeometry(new Shape(points.map((p) => new Vector2(p[0], -p[2]))));
}

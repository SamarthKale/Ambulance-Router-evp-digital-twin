/** Flat geometry generated from the SUMO network (CLAUDE.md section 11: roads are code, not models). */
import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Shape,
  ShapeGeometry,
  Vector2,
  type Color,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

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

/** The same polygon already lying in the XZ plane at `height`, facing up (for merging). */
export function groundPolygonGeometry(points: WorldPoint[], height = 0): BufferGeometry {
  return flatPolygonGeometry(points).rotateX(-Math.PI / 2).translate(0, height, 0);
}

export interface FlatRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Oriented flat rectangle: centre, unit direction u, length along u, width across. */
export interface FlatStrip {
  x: number;
  z: number;
  ux: number;
  uz: number;
  length: number;
  width: number;
}

type Corners = [number, number, number, number, number, number, number, number]; // x,z x4 around

function quads(corners: Corners[], height: number, colors?: Color[]): BufferGeometry {
  const positions = new Float32Array(corners.length * 12);
  const indices: number[] = [];
  const rgb = colors ? new Float32Array(corners.length * 12) : null;
  corners.forEach((c, q) => {
    // ensure counter-clockwise seen from above (+Y normal): signed area in (x, -z)
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      area += c[i * 2]! * -c[j * 2 + 1]! - c[j * 2]! * -c[i * 2 + 1]!;
    }
    const order = area > 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
    order.forEach((k, v) => {
      positions.set([c[k * 2]!, height, c[k * 2 + 1]!], q * 12 + v * 3);
      if (rgb && colors) rgb.set([colors[q]!.r, colors[q]!.g, colors[q]!.b], q * 12 + v * 3);
    });
    const b = q * 4;
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  if (rgb) geometry.setAttribute("color", new Float32BufferAttribute(rgb, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Axis-aligned rectangles as one flat, upward-facing geometry (optional colour per rect). */
export function rectsGeometry(rects: FlatRect[], height = 0, colors?: Color[]): BufferGeometry {
  return quads(
    rects.map((r) => [r.x0, r.z0, r.x1, r.z0, r.x1, r.z1, r.x0, r.z1]),
    height,
    colors,
  );
}

/** Oriented strips (paint) as one flat, upward-facing geometry. */
export function stripsGeometry(strips: FlatStrip[], height = 0): BufferGeometry {
  return quads(
    strips.map((s) => {
      const hx = (s.ux * s.length) / 2;
      const hz = (s.uz * s.length) / 2;
      const wx = (-s.uz * s.width) / 2;
      const wz = (s.ux * s.width) / 2;
      return [
        s.x - hx - wx, s.z - hz - wz,
        s.x + hx - wx, s.z + hz - wz,
        s.x + hx + wx, s.z + hz + wz,
        s.x - hx + wx, s.z - hz + wz,
      ];
    }),
    height,
  );
}

/** Raised boxes along strips (kerbed medians), merged into one geometry. */
export function stripBoxesGeometry(strips: FlatStrip[], height: number): BufferGeometry {
  const boxes = strips.map((s) =>
    new BoxGeometry(s.width, height, s.length)
      .rotateY(Math.atan2(s.ux, s.uz))
      .translate(s.x, height / 2, s.z),
  );
  if (boxes.length === 0) return new BufferGeometry();
  const merged = mergeGeometries(boxes, false);
  boxes.forEach((b) => b.dispose());
  return merged ?? new BufferGeometry();
}

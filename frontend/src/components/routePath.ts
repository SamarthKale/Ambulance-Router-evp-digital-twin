/**
 * Geometry of the suggested route (pure, unit-tested): the centre line of each road on the
 * route, joined through junctions by smooth curves, as a flat ribbon whose vertices carry
 * their distance along the route (so the part behind the ambulance can be hidden per frame).
 */
import { BufferGeometry, Float32BufferAttribute } from "three";

import { sumoToWorld, type Origin, type WorldPoint } from "../simulation/coords";
import type { LaneMsg, NetworkMsg } from "../simulation/state";

const CURVE_STEPS = 8;

/** Centre line of one road (the middle of its lanes), in world coordinates. */
export function edgeCentreLine(lanes: LaneMsg[], origin: Origin): WorldPoint[] {
  if (lanes.length === 0) return [];
  const sameShape = lanes.every((l) => l.shape.length === lanes[0]!.shape.length);
  const shape = sameShape
    ? lanes[0]!.shape.map((_, i) => {
        const xs = lanes.map((l) => l.shape[i]![0]);
        const ys = lanes.map((l) => l.shape[i]![1]);
        return [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length];
      })
    : lanes[Math.floor(lanes.length / 2)]!.shape;
  return shape.map(([x, y]) => sumoToWorld(x!, y!, origin));
}

/** Quadratic Bezier from a to c with control b. */
function curve(a: WorldPoint, b: WorldPoint, c: WorldPoint): WorldPoint[] {
  const out: WorldPoint[] = [];
  for (let i = 1; i < CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS;
    const u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], a[1], u * u * a[2] + 2 * u * t * b[2] + t * t * c[2]]);
  }
  return out;
}

/** Where the lines through (a1 -> a2) and (b1 -> b2) cross, or the midpoint if parallel. */
function crossing(a1: WorldPoint, a2: WorldPoint, b1: WorldPoint, b2: WorldPoint): WorldPoint {
  const dax = a2[0] - a1[0];
  const daz = a2[2] - a1[2];
  const dbx = b2[0] - b1[0];
  const dbz = b2[2] - b1[2];
  const det = dax * dbz - daz * dbx;
  if (Math.abs(det) < 1e-6) return [(a2[0] + b1[0]) / 2, a2[1], (a2[2] + b1[2]) / 2];
  const s = ((b1[0] - a1[0]) * dbz - (b1[2] - a1[2]) * dbx) / det;
  return [a1[0] + s * dax, a2[1], a1[2] + s * daz];
}

/** The route as one polyline: road centre lines joined by curves through the junctions. */
export function routePolyline(network: NetworkMsg, origin: Origin, edges: readonly string[]): WorldPoint[] {
  const byEdge = new Map<string, LaneMsg[]>();
  for (const lane of network.lanes) byEdge.set(lane.edge, [...(byEdge.get(lane.edge) ?? []), lane]);
  const points: WorldPoint[] = [];
  let previous: WorldPoint[] | null = null;
  for (const edge of edges) {
    const line = edgeCentreLine(byEdge.get(edge) ?? [], origin);
    if (line.length < 2) continue;
    if (previous) {
      const a2 = previous[previous.length - 1]!;
      const a1 = previous[previous.length - 2]!;
      const b1 = line[0]!;
      const b2 = line[1]!;
      points.push(...curve(a2, crossing(a1, a2, b1, b2), b1));
    }
    points.push(...line);
    previous = line;
  }
  return points;
}

/** Cumulative distance along a polyline (same length as the points). */
export function cumulative(points: readonly WorldPoint[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    out.push(out[i - 1]! + Math.hypot(b[0] - a[0], b[2] - a[2]));
  }
  return out;
}

/** Distance along the polyline of the point closest to (x, z). */
export function distanceAlong(points: readonly WorldPoint[], along: readonly number[], x: number, z: number): number {
  let best = Infinity;
  let at = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / len2));
    const px = a[0] + t * dx;
    const pz = a[2] + t * dz;
    const d = (px - x) ** 2 + (pz - z) ** 2;
    if (d < best) {
      best = d;
      at = along[i - 1]! + t * Math.sqrt(len2);
    }
  }
  return at;
}

/** A flat ribbon along the polyline facing up, with an `along` attribute (m from the start). */
export function routeRibbon(points: readonly WorldPoint[], width: number, height: number): BufferGeometry {
  const along = cumulative(points);
  const half = width / 2;
  const positions: number[] = [];
  const distance: number[] = [];
  const indices: number[] = [];
  points.forEach((p, i) => {
    const a = points[Math.max(0, i - 1)]!;
    const b = points[Math.min(points.length - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dz) || 1;
    const ox = -dz / len;
    const oz = dx / len;
    positions.push(p[0] + ox * half, height, p[2] + oz * half, p[0] - ox * half, height, p[2] - oz * half);
    distance.push(along[i]!, along[i]!);
    if (i > 0) {
      const k = 2 * i;
      indices.push(k - 2, k, k - 1, k - 1, k, k + 1); // counter-clockwise from above
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("along", new Float32BufferAttribute(distance, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

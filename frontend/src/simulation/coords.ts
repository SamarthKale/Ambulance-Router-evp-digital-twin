/**
 * SUMO <-> Three.js mapping (CLAUDE.md section 10). The only place this math lives.
 *
 * SUMO: x east, y north, angle in degrees clockwise from north.
 * Three.js: x east, y up, z south. The world is recentred on the network centre.
 * Per-asset rotation/pivot offsets belong to the asset manifest, never here.
 */
export interface Origin {
  cx: number;
  cy: number;
}

export type WorldPoint = [number, number, number];

export function originFromBounds([xmin, ymin, xmax, ymax]: [number, number, number, number]): Origin {
  return { cx: (xmin + xmax) / 2, cy: (ymin + ymax) / 2 };
}

export function sumoToWorld(x: number, y: number, origin: Origin, height = 0): WorldPoint {
  return [x - origin.cx, height, -(y - origin.cy)];
}

/** rotation.y for a model whose forward axis is +Z (glTF convention): north -> PI, east -> PI/2. */
export function sumoAngleToYaw(angleDeg: number): number {
  return Math.PI - (angleDeg * Math.PI) / 180;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate between two SUMO angles along the shorter arc (350 -> 10 passes 0). */
export function lerpAngleDeg(a: number, b: number, t: number): number {
  const delta = ((((b - a) % 360) + 540) % 360) - 180;
  return a + delta * t;
}

/** How far to blend from the previous tick to the latest one; clamped so we never extrapolate. */
export function interpolationAlpha(now: number, receivedAt: number, tickMs: number): number {
  return Math.min(1, Math.max(0, (now - receivedAt) / tickMs));
}

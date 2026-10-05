/**
 * Interpolated vehicle poses for the current animation frame, computed once per frame and
 * shared by the vehicle renderer, the ambulance and the chase camera (no extrapolation:
 * CLAUDE.md section 10).
 */
import { interpolationAlpha, lerp, lerpAngleDeg, sumoAngleToYaw, sumoToWorld, type Origin } from "./coords";
import { TICK_MS, type Frame, type VehicleMsg } from "./state";

export interface Pose {
  id: string;
  type: string;
  x: number; // world metres (vehicle centre)
  z: number;
  yaw: number; // rotation.y for a +Z-forward model
  speed: number; // m/s
}

export interface Poses {
  list: Pose[];
  byId: Map<string, Pose>;
}

let cachedTick: Frame | null = null;
let before = new Map<string, VehicleMsg>();

/** Poses at time `now` (performance.now() ms) between the two latest ticks. */
export function computePoses(prev: Frame | null, curr: Frame | null, origin: Origin, now: number, out: Poses): Poses {
  out.list.length = 0;
  out.byId.clear();
  if (!curr) return out;
  if (cachedTick !== curr) {
    cachedTick = curr;
    before = new Map(prev?.msg.vehicles.map((v) => [v.id, v]) ?? []);
  }
  const alpha = interpolationAlpha(now, curr.receivedAt, TICK_MS);
  for (const v of curr.msg.vehicles) {
    const a = before.get(v.id) ?? v;
    const [x, , z] = sumoToWorld(lerp(a.x, v.x, alpha), lerp(a.y, v.y, alpha), origin);
    const pose: Pose = {
      id: v.id,
      type: v.type,
      x,
      z,
      yaw: sumoAngleToYaw(lerpAngleDeg(a.angle, v.angle, alpha)),
      speed: lerp(a.speed, v.speed, alpha),
    };
    out.list.push(pose);
    out.byId.set(v.id, pose);
  }
  return out;
}

/** This frame's poses, filled by <PoseUpdater> before anything else runs. */
export const livePoses: Poses = { list: [], byId: new Map() };

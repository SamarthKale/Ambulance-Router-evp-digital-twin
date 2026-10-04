import { describe, expect, it } from "vitest";

import {
  interpolationAlpha,
  lerpAngleDeg,
  originFromBounds,
  sumoAngleToYaw,
  sumoToWorld,
} from "./coords";

const origin = originFromBounds([0, 0, 650, 650]);

describe("sumoToWorld", () => {
  it("recentres on the network and maps north to -z", () => {
    expect(origin).toEqual({ cx: 325, cy: 325 });
    expect(sumoToWorld(325, 325, origin)).toEqual([0, 0, -0]);
    expect(sumoToWorld(425, 325, origin)).toEqual([100, 0, -0]); // east -> +x
    expect(sumoToWorld(325, 425, origin)).toEqual([0, 0, -100]); // north -> -z
    expect(sumoToWorld(325, 325, origin, 2)[1]).toBe(2);
  });
});

describe("sumoAngleToYaw", () => {
  it.each([
    [0, Math.PI], // north
    [90, Math.PI / 2], // east
    [180, 0], // south
    [270, -Math.PI / 2], // west
  ])("SUMO %d deg -> yaw %f", (angle, yaw) => {
    expect(sumoAngleToYaw(angle)).toBeCloseTo(yaw);
  });

  it("points a +Z-forward model along the SUMO heading for every angle", () => {
    for (let angle = 0; angle < 360; angle += 15) {
      const yaw = sumoAngleToYaw(angle);
      const forward = [Math.sin(yaw), Math.cos(yaw)]; // +Z rotated by yaw, as (x, z)
      const rad = (angle * Math.PI) / 180;
      const heading = sumoToWorld(Math.sin(rad), Math.cos(rad), { cx: 0, cy: 0 }); // unit step
      expect(forward[0]).toBeCloseTo(heading[0]);
      expect(forward[1]).toBeCloseTo(heading[2]);
    }
  });
});

describe("lerpAngleDeg", () => {
  const heading = (deg: number) => ((deg % 360) + 360) % 360; // same direction, 0..360

  it("takes the short way round", () => {
    expect(heading(lerpAngleDeg(350, 10, 0.5))).toBeCloseTo(0);
    expect(heading(lerpAngleDeg(10, 350, 0.5))).toBeCloseTo(0);
    expect(lerpAngleDeg(90, 180, 0.5)).toBeCloseTo(135);
  });

  it("ends on the target heading", () => {
    expect(heading(lerpAngleDeg(0, 180, 1))).toBeCloseTo(180); // a U-turn: either way is fine
    expect(heading(lerpAngleDeg(300, 20, 1))).toBeCloseTo(20);
  });
});

describe("interpolationAlpha", () => {
  it("never extrapolates beyond the latest tick", () => {
    expect(interpolationAlpha(1000, 1000, 100)).toBe(0);
    expect(interpolationAlpha(1050, 1000, 100)).toBe(0.5);
    expect(interpolationAlpha(1500, 1000, 100)).toBe(1);
    expect(interpolationAlpha(900, 1000, 100)).toBe(0);
  });
});

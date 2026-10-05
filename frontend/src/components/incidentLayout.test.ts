import { describe, expect, it } from "vitest";

import { incidentProps, LANE_WIDTH, openSide } from "./incidentLayout";

describe("incident layout", () => {
  it("puts the open lane on the inner side of the curb lane", () => {
    // facing +Z, local +x is the driver's left
    expect(openSide(0, true)).toBe(-1); // left-hand traffic: the inner lane is to the right
    expect(openSide(1, true)).toBe(1);
    expect(openSide(0, false)).toBe(1);
    expect(openSide(1, false)).toBe(-1);
  });

  it("keeps every prop upstream of the wreck and inside the blocked lane", () => {
    for (const lefthand of [true, false]) {
      for (const lane of [0, 1]) {
        const props = incidentProps(lane, lefthand);
        expect(props.filter((p) => p.asset === "wrecked_car")).toHaveLength(1);
        for (const p of props) {
          expect(p.position[2]).toBeLessThanOrEqual(0); // traffic arrives from -Z
          expect(Math.abs(p.position[0])).toBeLessThanOrEqual(LANE_WIDTH / 2);
        }
      }
    }
  });

  it("tapers the cones towards the open lane as they near the wreck", () => {
    const side = openSide(0, true);
    const cones = incidentProps(0, true)
      .filter((p) => p.asset === "cone")
      .sort((a, b) => a.position[2] - b.position[2]); // furthest upstream first
    expect(cones.length).toBeGreaterThanOrEqual(3);
    const towardOpen = cones.map((c) => c.position[0] * side);
    for (let i = 1; i < towardOpen.length; i++) expect(towardOpen[i]!).toBeGreaterThan(towardOpen[i - 1]!);
  });
});

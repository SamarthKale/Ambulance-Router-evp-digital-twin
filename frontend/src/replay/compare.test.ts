import { describe, expect, it } from "vitest";

import { compareRuns, drivenMetres, type RunInfo } from "./compare";
import { makePlayback } from "./playback";
import { fakeRun, SUMMARY } from "./testData";

function info(arm: string, over: Partial<RunInfo> = {}, travel = 10): RunInfo {
  return {
    id: `${arm}/grid4x4_x1.5_seed001`,
    scenario: "grid4x4",
    scale: 1.5,
    seed: 1,
    arm,
    summary: { ...SUMMARY, travelS: travel },
    playback: null,
    ...over,
  };
}

describe("compareRuns", () => {
  it("computes the time saved from the two recorded travel times", () => {
    const result = compareRuns(info("basic_static", {}, 80.5), info("off_strict_static", {}, 132.7));
    expect(result.comparable).toBe(true);
    expect(result.timeSaved).toBeCloseTo(52.2);
    const travel = result.rows.find((r) => r.key === "travel");
    expect(travel).toMatchObject({ actual: 80.5, reference: 132.7, lowerIsBetter: true, source: "runs.csv" });
    expect(travel?.delta).toBeCloseTo(-52.2);
  });

  it("shows no time saved without a comparison run, or for the same run", () => {
    expect(compareRuns(info("basic_static"), null)).toMatchObject({ comparable: false, timeSaved: null });
    const same = info("basic_static");
    expect(compareRuns(same, same)).toMatchObject({ comparable: false, timeSaved: null });
  });

  it("refuses runs that did not start from the same traffic", () => {
    for (const other of [{ seed: 2 }, { scale: 1 }, { scenario: "grid2x2" }]) {
      const result = compareRuns(info("basic_static"), info("off_strict_static", other));
      expect(result.comparable).toBe(false);
      expect(result.timeSaved).toBeNull();
      expect(result.rows).toEqual([]);
    }
  });

  it("computes no time saved when a run did not arrive or has no result", () => {
    const stuck = info("off_strict_static", { summary: { ...SUMMARY, arrived: false, travelS: null } });
    expect(compareRuns(info("basic_static"), stuck)).toMatchObject({ comparable: true, timeSaved: null });
    expect(compareRuns(info("basic_static"), stuck).reason).toMatch(/did not arrive/);
    const missing = info("off_strict_static", { summary: null });
    expect(compareRuns(info("basic_static"), missing).reason).toMatch(/missing from runs.csv/);
    expect(compareRuns(info("basic_static"), missing).rows[0].reference).toBeNull();
  });

  it("takes the distance driven from the recorded track, and leaves it null without one", () => {
    const pb = makePlayback(fakeRun());
    const withTrack = info("basic_static", { playback: pb });
    expect(drivenMetres(withTrack)).toBeCloseTo(pb.distance[pb.distance.length - 1]);
    expect(drivenMetres(info("off_strict_static"))).toBeNull();
    const row = compareRuns(withTrack, info("off_strict_static")).rows.find((r) => r.key === "distance");
    expect(row).toMatchObject({ reference: null, delta: null, source: "recorded track" });
  });
});

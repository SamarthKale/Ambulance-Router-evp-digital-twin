import { describe, expect, it } from "vitest";

import { distanceSeries, extent, haltedSeries, KMH, linePath, percent, speedSeries, timeAtFraction } from "./charts";
import { makePlayback } from "./playback";
import { fakeRun } from "./testData";

const pb = makePlayback(fakeRun());

describe("chart series", () => {
  it("are the recorded values, converted only in units", () => {
    expect(speedSeries(pb, "actual").y).toEqual([0, 20 * KMH, 10 * KMH, 0]);
    expect(speedSeries(pb, "actual").x).toEqual([0, 5, 10, 12]);
    expect(distanceSeries(pb, "actual").y[0]).toBe(0);
    expect(haltedSeries(pb, "actual")).toMatchObject({ x: [0, 5, 10], y: [3, 1, 2] });
  });

  it("have a common extent that starts at zero", () => {
    const e = extent([speedSeries(pb, "a"), haltedSeries(pb, "b")]);
    expect(e.xmin).toBe(0);
    expect(e.xmax).toBe(12);
    expect(e.ymax).toBeGreaterThan(72);
    expect(extent([]).ymax).toBe(1); // no data: still a valid scale
  });

  it("draw as an SVG path inside the box", () => {
    const path = linePath({ label: "x", x: [0, 10], y: [0, 5] }, { xmin: 0, xmax: 10, ymin: 0, ymax: 10 }, 200, 100);
    expect(path).toBe("M0.0 100.0L200.0 50.0");
    expect(linePath({ label: "empty", x: [], y: [] }, extent([]), 10, 10)).toBe("");
  });

  it("map a pointer position back to a time", () => {
    const e = { xmin: 0, xmax: 120, ymin: 0, ymax: 1 };
    expect(timeAtFraction(0.5, e)).toBe(60);
    expect(timeAtFraction(-1, e)).toBe(0);
    expect(timeAtFraction(2, e)).toBe(120);
  });
});

describe("timeline positions", () => {
  it("stay inside the track even when the duration is stale or zero", () => {
    expect(percent(50, 100)).toBe(50);
    expect(percent(132.7, 85)).toBe(100); // a marker past the end of a shorter run
    expect(percent(-3, 100)).toBe(0);
    expect(percent(10, 0)).toBe(0);
  });
});

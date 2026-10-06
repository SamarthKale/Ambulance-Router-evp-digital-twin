import { describe, expect, it } from "vitest";

import type { ReplayIndexRunMsg } from "../simulation/state";
import { SUMMARY } from "./testData";
import { baselineFor, defaultRun, findRun, optionsFor, resolveChoice, siblingsOf, splitArm, armName } from "./runs";

function run(scale: number, arm: string, seed: number, telemetry: boolean): ReplayIndexRunMsg {
  const { strategy, routing } = splitArm(arm);
  return { id: `${arm}/grid4x4_x${scale}_seed${String(seed).padStart(3, "0")}`, scenario: "grid4x4", scale, seed, arm, strategy, routing, summary: SUMMARY, telemetry, matchesRecorded: telemetry ? true : null, traffic: telemetry, differences: [] };
}

const runs: ReplayIndexRunMsg[] = [
  ...[1, 2, 3].flatMap((seed) => ["off_strict_static", "basic_static", "coord_dynamic"].map((arm) => run(1.5, arm, seed, seed <= 2))),
  ...["off_strict_static", "basic_static"].map((arm) => run(0.75, arm, 1, true)),
  run(0.75, "basic_static", 7, false),
];

describe("run selection", () => {
  it("knows an arm's strategy and routing", () => {
    expect(splitArm("off_realistic_dynamic")).toEqual({ strategy: "off_realistic", routing: "dynamic" });
    expect(armName("coord_dynamic")).toBe("COORD · dynamic");
  });

  it("pairs a run with the OFF baseline of the same seed, and lists the other arms", () => {
    const basic = run(1.5, "basic_static", 2, true);
    expect(baselineFor(runs, basic)?.id).toBe("off_strict_static/grid4x4_x1.5_seed002");
    expect(baselineFor(runs, run(1.5, "basic_static", 9, false))).toBeNull(); // no baseline run for that seed
    expect(siblingsOf(runs, basic).map((r) => r.arm).sort()).toEqual(["coord_dynamic", "off_strict_static"]);
  });

  it("opens the demo setting first, then any recorded run", () => {
    expect(defaultRun(runs)?.scale).toBe(1.5);
    expect(defaultRun(runs)?.telemetry).toBe(true);
    expect(defaultRun([run(2, "basic_static", 4, false)])?.seed).toBe(4);
    expect(defaultRun([])).toBeNull();
  });

  it("offers only the values for which a run exists", () => {
    const choice = { scenario: "grid4x4", scale: 0.75, strategy: "basic", routing: "static", seed: 1 } as const;
    expect(optionsFor(runs, choice, "seed")).toEqual([1, 7]);
    expect(optionsFor(runs, choice, "scale")).toEqual([0.75, 1.5]);
    expect(optionsFor(runs, choice, "strategy")).toEqual(["basic", "off_strict"]);
  });

  it("keeps the other choices when it can, and prefers a seed that has a playback", () => {
    const from = { scenario: "grid4x4", scale: 1.5, strategy: "basic", routing: "static", seed: 3 } as const;
    // changing the demand: seed 3 does not exist at 0.75, the recorded seed 1 is taken
    expect(resolveChoice(runs, { ...from, scale: 0.75 }, "scale")).toMatchObject({ scale: 0.75, strategy: "basic", seed: 1 });
    // a seed chosen on purpose is kept even without a playback
    expect(resolveChoice(runs, { ...from, scale: 0.75, seed: 7 }, "seed")).toMatchObject({ scale: 0.75, seed: 7 });
    // changing the mode keeps demand and routing where a run exists
    expect(resolveChoice(runs, { ...from, strategy: "coord", routing: "static" }, "strategy")).toMatchObject({ strategy: "coord", routing: "dynamic", scale: 1.5 });
    expect(resolveChoice([], from, "scale")).toBeNull();
    expect(findRun(runs, { scenario: "grid4x4", scale: 1.5, strategy: "basic", routing: "static", seed: 1 })?.arm).toBe("basic_static");
  });
});

import { parseDeepLink } from "./runs";

describe("deep links", () => {
  it("reads run, reference and time from the address", () => {
    expect(parseDeepLink("?run=basic_static/grid4x4_x1.5_seed001&ref=off_strict_static/grid4x4_x1.5_seed001&t=40")).toEqual({
      run: "basic_static/grid4x4_x1.5_seed001",
      ref: "off_strict_static/grid4x4_x1.5_seed001",
      t: 40,
    });
    expect(parseDeepLink("")).toEqual({ run: null, ref: null, t: null });
    expect(parseDeepLink("?t=abc").t).toBeNull();
    expect(parseDeepLink("?t=-3").t).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { results } from "../simulation/contract.fixtures";
import { formatP, formatPaired, travelBars } from "./resultsChart";

describe("results chart", () => {
  const arms = results.experiments[0]!.arms;

  it("draws one bar per arm on an axis rounded up past the widest interval", () => {
    const { bars, max } = travelBars(arms);
    expect(bars.map((b) => b.arm)).toEqual(["off_strict_static", "coord_dynamic"]);
    expect(max).toBe(250); // highest CI end 201 s
    expect(bars[0]!.dashed).toBe(true); // static routing
    expect(bars[1]).toMatchObject({ mean: 120.1, low: 110.0, high: 130.5, dashed: false });
  });

  it("formats paired differences with their interval and p-value", () => {
    expect(formatPaired(arms[1]!.travelVsBaseline, "s")).toBe("−60 s [−80, −41], p = 0.25");
    expect(formatPaired(arms[0]!.travelVsBaseline, "s")).toBe(""); // the baseline itself
    expect(formatP(0.0004)).toBe("p < 0.001");
    expect(formatP(0.0042)).toBe("p = 0.004");
  });
});

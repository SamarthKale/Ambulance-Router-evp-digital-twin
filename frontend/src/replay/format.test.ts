import { describe, expect, it } from "vitest";

import { clockText, count, NOT_RECORDED, num, signed } from "./format";

describe("format", () => {
  it("says Not recorded for a missing value, never 0", () => {
    expect(num(null)).toBe(NOT_RECORDED);
    expect(num(undefined, 1, "s")).toBe(NOT_RECORDED);
    expect(num(Number.NaN)).toBe(NOT_RECORDED);
    expect(count(null)).toBe(NOT_RECORDED);
    expect(count(0)).toBe("0");
    expect(num(0, 1, "s")).toBe("0.0 s");
  });

  it("writes times as m:ss.s", () => {
    expect(clockText(0)).toBe("0:00.0");
    expect(clockText(75.34)).toBe("1:15.3");
    expect(clockText(-5)).toBe("0:00.0");
  });

  it("signs differences, and shows a difference that rounds to zero as 0", () => {
    expect(signed(51.64)).toBe("+51.6");
    expect(signed(-51.64)).toBe("−51.6");
    expect(signed(-0.01)).toBe("0.0");
    expect(signed(0, 0)).toBe("0");
    expect(signed(-3, 0, "s")).toBe("−3 s");
  });
});

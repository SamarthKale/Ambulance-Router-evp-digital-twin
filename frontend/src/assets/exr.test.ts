import { DataUtils } from "three";
import { describe, expect, it } from "vitest";

import { downsampleToHalf } from "./exr";

describe("skybox downsampling", () => {
  it("averages 2x2 blocks of RGBA and packs half floats", () => {
    // 4x2 image: left block 1..4 in red, right block constant 8; green/blue/alpha constant
    const px = (r: number) => [r, 0.5, 0.25, 1];
    const src = new Float32Array([...px(1), ...px(2), ...px(8), ...px(8), ...px(3), ...px(4), ...px(8), ...px(8)]);
    const out = downsampleToHalf(src, 4, 2, 2);
    expect([out.width, out.height, out.clamped]).toEqual([2, 1, 0]);
    const values = Array.from(out.data, (h) => DataUtils.fromHalfFloat(h));
    expect(values).toEqual([2.5, 0.5, 0.25, 1, 8, 0.5, 0.25, 1]);
  });

  it("clamps the sun to the largest half float instead of overflowing", () => {
    const src = new Float32Array([1e6, 1e6, 1e6, 1]);
    const out = downsampleToHalf(src, 1, 1, 1);
    expect(out.clamped).toBe(3);
    expect(DataUtils.fromHalfFloat(out.data[0]!)).toBe(65504);
  });
});

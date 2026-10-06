import { describe, expect, it } from "vitest";

import { approach, fitCamera, frameTargets, MAX_SCALE, panBy, toScreen, toWorld, zoomAt } from "./camera";

const W = 800;
const H = 600;
const bounds: [number, number, number, number] = [0, 0, 1000, 1000];
const fit = fitCamera(bounds, W, H);

describe("camera", () => {
  it("fits the bounds in the view, centred", () => {
    expect(fit.cx).toBe(500);
    expect(fit.cy).toBe(500);
    const [x0, y0] = toScreen(fit, W, H, 0, 0);
    const [x1, y1] = toScreen(fit, W, H, 1000, 1000);
    expect(x0).toBeGreaterThanOrEqual(0);
    expect(x1).toBeLessThanOrEqual(W);
    expect(y1).toBeGreaterThanOrEqual(0); // y points up
    expect(y0).toBeLessThanOrEqual(H);
  });

  it("converts between screen and world (y up) both ways", () => {
    const cam = { cx: 120, cy: 340, scale: 2.5 };
    const [sx, sy] = toScreen(cam, W, H, 200, 400);
    const [wx, wy] = toWorld(cam, W, H, sx, sy);
    expect(wx).toBeCloseTo(200);
    expect(wy).toBeCloseTo(400);
    expect(toScreen(cam, W, H, 120, 340)).toEqual([W / 2, H / 2]);
  });

  it("zooms around the point under the cursor, within limits", () => {
    const [wx, wy] = toWorld(fit, W, H, 200, 100);
    const zoomed = zoomAt(fit, W, H, 200, 100, 2, fit);
    expect(zoomed.scale).toBeCloseTo(fit.scale * 2);
    const [sx, sy] = toScreen(zoomed, W, H, wx, wy);
    expect(sx).toBeCloseTo(200);
    expect(sy).toBeCloseTo(100);
    expect(zoomAt(fit, W, H, 0, 0, 1000, fit).scale).toBe(MAX_SCALE);
    expect(zoomAt(fit, W, H, 0, 0, 0.0001, fit).scale).toBeCloseTo(fit.scale * 0.6);
  });

  it("pans so the map follows the drag", () => {
    const panned = panBy(fit, 50, -20);
    const [sx, sy] = toScreen(panned, W, H, fit.cx, fit.cy);
    expect(sx).toBeCloseTo(W / 2 + 50);
    expect(sy).toBeCloseTo(H / 2 - 20);
  });

  it("frames two targets with a margin and never closer than the minimum scale", () => {
    const cam = frameTargets([[100, 100], [400, 300]], W, H, 0.3);
    expect(cam.cx).toBe(250);
    expect(cam.cy).toBe(200);
    for (const [x, y] of [[100, 100], [400, 300]] as const) {
      const [sx, sy] = toScreen(cam, W, H, x, y);
      expect(sx).toBeGreaterThan(0);
      expect(sx).toBeLessThan(W);
      expect(sy).toBeGreaterThan(0);
      expect(sy).toBeLessThan(H);
    }
    expect(frameTargets([[0, 0], [5000, 5000]], W, H, 0.3).scale).toBe(0.3);
    expect(Number.isFinite(frameTargets([[10, 10]], W, H, 0.3).scale)).toBe(true); // one point
  });

  it("moves a fraction of the way to a target", () => {
    const next = approach({ cx: 0, cy: 0, scale: 1 }, { cx: 10, cy: 20, scale: 3 }, 0.5);
    expect(next).toEqual({ cx: 5, cy: 10, scale: 2 });
  });
});

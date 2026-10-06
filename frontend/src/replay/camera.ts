/** 2D map camera: centre in SUMO metres and scale in pixels per metre (y points up on screen). */
import type { Point } from "../simulation/state";

export interface Camera {
  cx: number;
  cy: number;
  scale: number;
}

export const MIN_SCALE_FACTOR = 0.6; // of the fit scale
export const MAX_SCALE = 14; // px per metre

export function fitCamera(bounds: [number, number, number, number], w: number, h: number, pad = 28): Camera {
  const [xmin, ymin, xmax, ymax] = bounds;
  const scale = Math.max(0.01, Math.min((w - 2 * pad) / (xmax - xmin), (h - 2 * pad) / (ymax - ymin)));
  return { cx: (xmin + xmax) / 2, cy: (ymin + ymax) / 2, scale };
}

export function toScreen(c: Camera, w: number, h: number, x: number, y: number): Point {
  return [(x - c.cx) * c.scale + w / 2, h / 2 - (y - c.cy) * c.scale];
}

export function toWorld(c: Camera, w: number, h: number, sx: number, sy: number): Point {
  return [(sx - w / 2) / c.scale + c.cx, (h / 2 - sy) / c.scale + c.cy];
}

/** Zoom by `factor` keeping the world point under (sx, sy) fixed. */
export function zoomAt(c: Camera, w: number, h: number, sx: number, sy: number, factor: number, fit: Camera): Camera {
  const scale = Math.min(MAX_SCALE, Math.max(fit.scale * MIN_SCALE_FACTOR, c.scale * factor));
  const [wx, wy] = toWorld(c, w, h, sx, sy);
  return { scale, cx: wx - (sx - w / 2) / scale, cy: wy + (sy - h / 2) / scale };
}

export function panBy(c: Camera, dxPx: number, dyPx: number): Camera {
  return { ...c, cx: c.cx - dxPx / c.scale, cy: c.cy + dyPx / c.scale };
}

/** A camera showing all `targets` with a margin (never closer than minScale or beyond MAX_SCALE). */
export function frameTargets(targets: readonly Point[], w: number, h: number, minScale: number, margin = 90): Camera {
  const xs = targets.map((p) => p[0]);
  const ys = targets.map((p) => p[1]);
  const xmin = Math.min(...xs);
  const xmax = Math.max(...xs);
  const ymin = Math.min(...ys);
  const ymax = Math.max(...ys);
  const spanX = Math.max(1, xmax - xmin);
  const spanY = Math.max(1, ymax - ymin);
  const scale = Math.min(MAX_SCALE * 0.6, Math.max(minScale, Math.min((w - 2 * margin) / spanX, (h - 2 * margin) / spanY)));
  return { cx: (xmin + xmax) / 2, cy: (ymin + ymax) / 2, scale };
}

/** Move the camera a fraction of the way to `target` (smooth follow). */
export function approach(c: Camera, target: Camera, k: number): Camera {
  return {
    cx: c.cx + (target.cx - c.cx) * k,
    cy: c.cy + (target.cy - c.cy) * k,
    scale: c.scale + (target.scale - c.scale) * k,
  };
}

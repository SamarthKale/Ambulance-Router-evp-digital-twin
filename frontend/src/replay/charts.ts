/** Chart series, all taken from the recorded telemetry (no smoothing, no filling of gaps). */
import { totalHalting, type Playback } from "./playback";

export interface Series {
  label: string;
  x: number[]; // seconds since the dispatch
  y: number[];
}

export const KMH = 3.6;

export function speedSeries(pb: Playback, label: string): Series {
  return { label, x: pb.times, y: pb.run.ambulance.map((s) => s[4] * KMH) };
}

/** Metres driven, summed from the recorded positions. */
export function distanceSeries(pb: Playback, label: string): Series {
  return { label, x: pb.times, y: pb.distance };
}

/** Vehicles halted (below 0.1 m/s) on all roads, every 5 s as recorded. */
export function haltedSeries(pb: Playback, label: string): Series {
  return { label, x: pb.edgeTimes, y: pb.edgeTimes.map((_, i) => totalHalting(pb, i)) };
}

export interface Extent {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

export function extent(series: readonly Series[], minDuration = 1): Extent {
  let xmax = minDuration;
  let ymax = 0;
  for (const s of series) {
    for (const v of s.x) xmax = Math.max(xmax, v);
    for (const v of s.y) ymax = Math.max(ymax, v);
  }
  return { xmin: 0, xmax, ymin: 0, ymax: ymax > 0 ? ymax * 1.08 : 1 };
}

/** SVG path for a series inside a w x h box with the extent's axes. */
export function linePath(s: Series, e: Extent, w: number, h: number): string {
  let d = "";
  for (let i = 0; i < s.x.length; i++) {
    const px = ((s.x[i] - e.xmin) / (e.xmax - e.xmin)) * w;
    const py = h - ((s.y[i] - e.ymin) / (e.ymax - e.ymin)) * h;
    d += `${i === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`;
  }
  return d;
}

/** The time under a pointer at fraction `u` (0..1) across the chart. */
export function timeAtFraction(u: number, e: Extent): number {
  return e.xmin + Math.min(1, Math.max(0, u)) * (e.xmax - e.xmin);
}

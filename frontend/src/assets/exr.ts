/** Skybox pixel helpers (pure, unit-tested; used by exrWorker.ts). */
import { DataUtils } from "three";

const HALF_MAX = 65504;

/** Average `factor` x `factor` blocks of RGBA floats and pack them as half floats. */
export function downsampleToHalf(
  src: Float32Array,
  width: number,
  height: number,
  factor: number,
): { data: Uint16Array; width: number; height: number; clamped: number } {
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new Uint16Array(w * h * 4);
  const n = factor * factor;
  let clamped = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) {
          const row = (y * factor + dy) * width;
          for (let dx = 0; dx < factor; dx++) sum += src[(row + x * factor + dx) * 4 + c]!;
        }
        let v = sum / n;
        if (v > HALF_MAX) {
          v = HALF_MAX;
          clamped += 1;
        }
        out[(y * w + x) * 4 + c] = DataUtils.toHalfFloat(v);
      }
    }
  }
  return { data: out, width: w, height: h, clamped };
}

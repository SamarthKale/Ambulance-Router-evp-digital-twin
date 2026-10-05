/// <reference lib="webworker" />
/**
 * Decode the delivered 72 MB OpenEXR skybox off the main thread (16 s on the main thread in
 * Sprint 4). The file is fetched and decoded as delivered; the worker then box-filters a
 * display copy (2x: 4096x2048 -> 2048x1024), which halves the main-thread stall when the
 * sky goes in (0.19 s vs 0.47 s measured on the integrated GPU). Only the display copy
 * travels back (transferred, not copied).
 */
import { FloatType } from "three";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";

import { downsampleToHalf } from "./exr";

export interface ExrRequest {
  url: string;
  /** Box-filter factor for the display copy (1 = full size). */
  downsample: number;
}

export interface ExrResult {
  ok: true;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  data: Uint16Array; // RGBA half floats
  fetchMs: number;
  decodeMs: number;
  bytes: number;
  clamped: number; // sun pixels above the half-float range
}

export interface ExrFailure {
  ok: false;
  error: string;
}

self.onmessage = async (event: MessageEvent<ExrRequest>) => {
  try {
    const t0 = performance.now();
    const response = await fetch(event.data.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const t1 = performance.now();
    const parsed = new EXRLoader().setDataType(FloatType).parse(buffer) as {
      width: number;
      height: number;
      data: Float32Array;
    };
    if (parsed.data.length !== parsed.width * parsed.height * 4) throw new Error("expected RGBA pixels");
    const small = downsampleToHalf(parsed.data, parsed.width, parsed.height, Math.max(1, event.data.downsample));
    const result: ExrResult = {
      ok: true,
      width: small.width,
      height: small.height,
      sourceWidth: parsed.width,
      sourceHeight: parsed.height,
      data: small.data,
      fetchMs: Math.round(t1 - t0),
      decodeMs: Math.round(performance.now() - t1),
      bytes: buffer.byteLength,
      clamped: small.clamped,
    };
    (self as unknown as Worker).postMessage(result, [small.data.buffer]);
  } catch (error) {
    const failure: ExrFailure = { ok: false, error: error instanceof Error ? error.message : String(error) };
    (self as unknown as Worker).postMessage(failure);
  }
};

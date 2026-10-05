/**
 * Sky and image-based light.
 *
 * - First frame: a plain sky colour plus a generated room environment, so the PBR models
 *   are lit at once.
 * - Once the scene is interactive: the delivered 4k EXR skybox (Member 2) is fetched and
 *   decoded in a Web Worker (16 s on the main thread in Sprint 4), then becomes the
 *   background and the environment light.
 * - The top view keeps the plain colour and no fog.
 */
import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import {
  Color,
  DataTexture,
  EquirectangularReflectionMapping,
  Fog,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  PMREMGenerator,
  RGBAFormat,
  type Texture,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { create } from "zustand";

import { useAssetStore } from "../assets/loader";
import { SKYBOX, modelUrl } from "../assets/manifest";
import type { ExrFailure, ExrRequest, ExrResult } from "../assets/exrWorker";

export const SKY_COLOR = "#b9d3ea";
const FOG_NEAR = 450;
const FOG_FAR = 2200;
const SKYBOX_DELAY_MS = 1500; // after the scene is interactive
const SKY_DOWNSAMPLE = 2; // 4096x2048 file -> 2048x1024 texture: swap stall 0.19 s (0.47 s at 4k)
const SKY_SOURCE_WIDTH = 4096; // the delivered EXR
const ENV_CUBE_SIZE = SKY_SOURCE_WIDTH / SKY_DOWNSAMPLE / 4; // PMREM cube size three picks for it

interface SkyState {
  status: "waiting" | "loading" | "ready" | "error";
  message?: string;
  set: (status: SkyState["status"], message?: string) => void;
}

export const useSkyStore = create<SkyState>()((set) => ({
  status: "waiting",
  set: (status, message) => set({ status, message }),
}));

let skybox: Promise<DataTexture> | null = null;

/** Fetch + decode the EXR once per page (in a worker). */
export function loadSkybox(): Promise<DataTexture> {
  skybox ??= new Promise<DataTexture>((resolve, reject) => {
    const store = useSkyStore.getState();
    store.set("loading");
    const worker = new Worker(new URL("../assets/exrWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<ExrResult | ExrFailure>) => {
      worker.terminate();
      const r = event.data;
      if (!r.ok) {
        console.warn(`[assets] skybox: ${r.error}; keeping the plain sky`);
        store.set("error", r.error);
        reject(new Error(r.error));
        return;
      }
      const texture = new DataTexture(r.data, r.width, r.height, RGBAFormat, HalfFloatType);
      texture.mapping = EquirectangularReflectionMapping;
      texture.colorSpace = LinearSRGBColorSpace;
      texture.minFilter = LinearFilter;
      texture.magFilter = LinearFilter;
      texture.generateMipmaps = false;
      texture.flipY = false;
      texture.needsUpdate = true;
      const mb = (r.bytes / 1e6).toFixed(0);
      store.set(
        "ready",
        `${r.sourceWidth}x${r.sourceHeight} (${mb} MB) shown at ${r.width}x${r.height}: ` +
          `fetch ${r.fetchMs} ms, decode ${r.decodeMs} ms in a worker`,
      );
      resolve(texture);
    };
    worker.onerror = (event) => {
      worker.terminate();
      store.set("error", event.message);
      reject(new Error(event.message));
    };
    const request: ExrRequest = { url: modelUrl(SKYBOX.file), downsample: SKY_DOWNSAMPLE };
    worker.postMessage(request);
  });
  return skybox;
}

export function Sky({ flat }: { flat: boolean }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const interactive = useAssetStore((s) => s.interactive);
  const status = useSkyStore((s) => s.status);

  // generated environment first: models look right before the skybox arrives. Same cube
  // size as the skybox's PMREM (texture width / 4): swapping environments of different
  // sizes changes a shader define and recompiles every material (a 1.7 s freeze).
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    const room = pmrem.fromScene(new RoomEnvironment(), 0.04, 0.1, 100, { size: ENV_CUBE_SIZE }).texture;
    if (!scene.environment) scene.environment = room;
    scene.environmentIntensity = 0.55;
    return () => {
      if (scene.environment === room) scene.environment = null;
      room.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);

  useEffect(() => {
    if (!interactive || status !== "waiting") return;
    const timer = window.setTimeout(() => void loadSkybox().catch(() => undefined), SKYBOX_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [interactive, status]);

  useEffect(() => {
    if (status !== "ready") return;
    let env: Texture | null = null;
    let sky: Texture | null = null;
    let cancelled = false;
    void loadSkybox().then((texture) => {
      if (cancelled) return;
      sky = texture;
      const pmrem = new PMREMGenerator(gl);
      env = pmrem.fromEquirectangular(texture).texture;
      pmrem.dispose();
      scene.environment = env;
      scene.environmentIntensity = 0.8;
    });
    return () => {
      cancelled = true;
      if (env && scene.environment === env) scene.environment = null;
      env?.dispose();
      void sky;
    };
  }, [gl, scene, status]);

  useEffect(() => {
    if (flat) {
      scene.background = new Color(SKY_COLOR);
      scene.fog = null;
      return;
    }
    scene.fog = new Fog(SKY_COLOR, FOG_NEAR, FOG_FAR);
    if (status !== "ready") {
      scene.background = new Color(SKY_COLOR);
      return;
    }
    let cancelled = false;
    void loadSkybox().then((texture) => {
      if (!cancelled) scene.background = texture;
    });
    return () => {
      cancelled = true;
    };
  }, [flat, scene, status]);

  return null;
}

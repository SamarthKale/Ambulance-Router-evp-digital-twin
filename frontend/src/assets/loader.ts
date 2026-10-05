/**
 * Load delivered models once per asset key, prepare them, and fall back to placeholders.
 *
 * - `enabled: false` never fetches.
 * - A 404 or parse error logs one warning and keeps the placeholder.
 * - Missing required parts log one warning; generated stand-ins replace them.
 * - `lazy` assets wait until the scene is interactive (first frames drawn).
 * The app runs with no model at all: every hook returns the placeholder first.
 */
import { useEffect, useState } from "react";
import { LoadingManager } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { create } from "zustand";

import { MANIFEST, modelUrl, type AssetKey } from "./manifest";
import { fallbackParts, placeholderAsset, prepareScene, type PreparedAsset } from "./prepare";

export type LoadStatus = "idle" | "waiting" | "loading" | "loaded" | "placeholder" | "error";

export interface AssetLoadState {
  status: LoadStatus;
  message?: string;
  ms?: number; // fetch + parse + prepare
}

interface AssetStore {
  states: Partial<Record<AssetKey, AssetLoadState>>;
  /** Set once the scene has drawn its first frames: lazy assets may load from then on. */
  interactive: boolean;
  set: (key: AssetKey, state: AssetLoadState) => void;
  setInteractive: () => void;
}

export const useAssetStore = create<AssetStore>()((set, get) => ({
  states: {},
  interactive: false,
  set: (key, state) => set({ states: { ...get().states, [key]: state } }),
  setInteractive: () => {
    if (!get().interactive) set({ interactive: true });
  },
}));

const placeholders = new Map<AssetKey, PreparedAsset>();
const loads = new Map<AssetKey, Promise<PreparedAsset>>();
const loaded = new Map<AssetKey, PreparedAsset>();

export function placeholderOf(key: AssetKey): PreparedAsset {
  let asset = placeholders.get(key);
  if (!asset) {
    asset = placeholderAsset(MANIFEST[key]);
    placeholders.set(key, asset);
  }
  return asset;
}

let gltfLoader: GLTFLoader | null = null;

function loader(): GLTFLoader {
  // No Draco/Meshopt decoders: no delivered file uses those extensions (check:assets).
  gltfLoader ??= new GLTFLoader(new LoadingManager());
  return gltfLoader;
}

/** Fetch and prepare a model (once per key). Resolves to the placeholder on failure. */
export function loadAsset(key: AssetKey): Promise<PreparedAsset> {
  const existing = loads.get(key);
  if (existing) return existing;
  const entry = MANIFEST[key];
  const store = useAssetStore.getState();
  if (!entry.enabled) {
    store.set(key, { status: "placeholder", message: "disabled in the manifest" });
    const done = Promise.resolve(placeholderOf(key));
    loads.set(key, done);
    return done;
  }
  const started = performance.now();
  store.set(key, { status: "loading" });
  const promise = loader()
    .loadAsync(modelUrl(entry.file))
    .then((gltf) => {
      const asset = prepareScene(gltf.scene, entry);
      if (asset.missingParts.length) {
        console.warn(
          `[assets] ${key}: missing required parts ${asset.missingParts.join(", ")}; using generated stand-ins`,
        );
        asset.parts.push(...fallbackParts(entry, asset));
      }
      const ms = Math.round(performance.now() - started);
      const message = asset.missingParts.length ? `missing parts: ${asset.missingParts.join(", ")}` : undefined;
      useAssetStore.getState().set(key, { status: "loaded", message, ms });
      loaded.set(key, asset);
      return asset;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[assets] ${key}: could not load ${entry.file} (${message}); using the placeholder`);
      useAssetStore.getState().set(key, { status: "error", message });
      return placeholderOf(key);
    });
  loads.set(key, promise);
  return promise;
}

/**
 * The prepared asset for a key: the placeholder until the model is ready.
 * `load: false` keeps the placeholder without fetching (e.g. a heavy model shown on demand).
 */
export function useAsset(key: AssetKey, load = true): PreparedAsset {
  const lazy = "lazy" in MANIFEST[key] && MANIFEST[key].lazy === true;
  const interactive = useAssetStore((s) => s.interactive);
  const [asset, setAsset] = useState<PreparedAsset>(() => loaded.get(key) ?? placeholderOf(key));
  const ready = load && (!lazy || interactive);

  useEffect(() => {
    if (!load) return;
    if (!ready) {
      if (!useAssetStore.getState().states[key]) useAssetStore.getState().set(key, { status: "waiting" });
      return;
    }
    let cancelled = false;
    void loadAsset(key).then((a) => {
      if (!cancelled) setAsset(a);
    });
    return () => {
      cancelled = true;
    };
  }, [key, load, ready]);

  return asset;
}

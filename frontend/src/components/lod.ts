/**
 * Level of detail for instanced copies, decided per copy on the CPU (CLAUDE.md: heavy
 * assets are handled in the renderer, never by editing the file).
 *
 * Every few frames each copy is tested against the camera frustum and given its projected
 * size in pixels. Big enough: the delivered model. Smaller: the manifest placeholder (a
 * cone for a tree, a box for a car) or nothing. A 6k-triangle tree 400 m away is a few
 * pixels tall, so drawing the model there buys nothing.
 */
import { Frustum, Matrix4, Sphere, Vector3, type Camera, type OrthographicCamera, type PerspectiveCamera } from "three";

import type { AssetKey } from "../assets/manifest";

export interface LodRule {
  /** Projected bounding-sphere radius (px) from which the real model is drawn. */
  minPx: number;
  /** Below minPx: the placeholder, or nothing. */
  far: "placeholder" | "hide";
  /** Below this the copy is not drawn at all (placeholder rule only). */
  hidePx?: number;
}

const DEFAULT_RULE: LodRule = { minPx: 0, far: "hide" };

export const LOD_RULES: Partial<Record<AssetKey, LodRule>> = {
  tree: { minPx: 30, far: "placeholder", hidePx: 1.5 },
  tree_pine: { minPx: 30, far: "placeholder", hidePx: 1.5 },
  grass_patch: { minPx: 14, far: "hide" },
  hydrant: { minPx: 5, far: "hide" },
  trashcan: { minPx: 5, far: "hide" },
  bench: { minPx: 5, far: "hide" },
  sign_stop: { minPx: 5, far: "hide" },
  sign_no_parking: { minPx: 5, far: "hide" },
  fuel_pump: { minPx: 5, far: "hide" },
  path_tile: { minPx: 4, far: "hide" },
  divider: { minPx: 4, far: "hide" },
  pedestrian_signal: { minPx: 10, far: "placeholder", hidePx: 2 },
  streetlight: { minPx: 6, far: "hide" },
  auto_rickshaw: { minPx: 10, far: "placeholder", hidePx: 1 },
  scooter: { minPx: 8, far: "hide" },
  police_car: { minPx: 12, far: "placeholder", hidePx: 1 },
  truck: { minPx: 12, far: "placeholder", hidePx: 1 },
  fire_truck: { minPx: 12, far: "placeholder", hidePx: 1 },
  // buildings: a box once they are small (fog starts at 450 m; boxes are ~430 m out)
  building_01: { minPx: 30, far: "placeholder", hidePx: 0 },
  building_02: { minPx: 30, far: "placeholder", hidePx: 0 },
  building_03: { minPx: 30, far: "placeholder", hidePx: 0 },
  building_04: { minPx: 30, far: "placeholder", hidePx: 0 },
  building_05: { minPx: 30, far: "placeholder", hidePx: 0 },
  residential: { minPx: 30, far: "placeholder", hidePx: 0 },
  shops: { minPx: 25, far: "placeholder", hidePx: 0 },
  petrol_station: { minPx: 25, far: "placeholder", hidePx: 0 },
};

/** Moving traffic: the car model while it is at least this big on screen, a box below. */
export const VEHICLE_MIN_PX = 9;

/** Static copies are re-culled every this many frames (the camera moves smoothly). */
export const CULL_EVERY = 2;

/**
 * Frame order (useFrame priorities; negative ones keep R3F's automatic rendering):
 *   -3 interpolated poses -> -2 camera rig -> -1 orbit controls -> -0.5 frustum for culling
 *   -> 0 renderers (vehicles, instanced props, ambulance, labels).
 */
export const FRAME = { poses: -3, camera: -2, cull: -0.5 } as const;

/** Culling margin (m): copies just outside the view stay drawn while it turns. */
const CULL_MARGIN = 3;

export function lodRule(key: AssetKey): LodRule {
  return LOD_RULES[key] ?? DEFAULT_RULE;
}

/** Frustum + projected size for the current camera; refreshed once per frame. */
export class ScreenSpace {
  /** Frames since start: instanced layers re-cull every CULL_EVERY frames. */
  frame = 0;

  private readonly frustum = new Frustum();
  private readonly matrix = new Matrix4();
  private readonly sphere = new Sphere();
  private readonly eye = new Vector3();
  private pxPerUnitAtUnitDistance = 1;
  private orthoPxPerUnit = 0;

  update(camera: Camera, viewportHeight: number): void {
    this.frame += 1;
    camera.updateMatrixWorld();
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);
    camera.getWorldPosition(this.eye);
    const ortho = camera as OrthographicCamera;
    if (ortho.isOrthographicCamera) {
      this.orthoPxPerUnit = (ortho.zoom * viewportHeight) / Math.max(1e-6, ortho.top - ortho.bottom);
    } else {
      const persp = camera as PerspectiveCamera;
      this.orthoPxPerUnit = 0;
      this.pxPerUnitAtUnitDistance = viewportHeight / (2 * Math.tan((persp.fov * Math.PI) / 360));
    }
  }

  /** Projected radius in pixels, or -1 when the sphere is outside the frustum. */
  pixels(x: number, y: number, z: number, radius: number): number {
    this.sphere.center.set(x, y, z);
    this.sphere.radius = radius + CULL_MARGIN;
    if (!this.frustum.intersectsSphere(this.sphere)) return -1;
    if (this.orthoPxPerUnit > 0) return radius * this.orthoPxPerUnit;
    const d = Math.max(0.1, this.sphere.center.distanceTo(this.eye));
    return (radius * this.pxPerUnitAtUnitDistance) / d;
  }
}

/** The scene's screen space, updated first thing every frame (CityScene). */
export const screen = new ScreenSpace();

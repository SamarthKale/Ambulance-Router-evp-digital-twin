/**
 * Cameras: chase (behind the ambulance; a city overview while none is out), orbit (free
 * mouse camera) and top (2D map, F follows the ambulance). C cycles through them.
 * The view is centred in the free area between the HUD panels.
 */
import { MapControls, OrthographicCamera, PerspectiveCamera } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef, type ComponentRef } from "react";
import { Vector3, type OrthographicCamera as OrthoCam, type PerspectiveCamera as PerspCam } from "three";

import { hudInsets } from "../dashboard/layout";
import { sumoToWorld, type Origin } from "../simulation/coords";
import { livePoses, type Pose } from "../simulation/poses";
import { AMBULANCE_ID, useSim, type NetworkMsg, type ViewMode } from "../simulation/state";
import { FRAME } from "./lod";

const CHASE_BACK = 15; // m behind the ambulance
const CHASE_UP = 6.5; // m above the road
const CHASE_AHEAD = 12; // m ahead: where the camera looks
const CHASE_RATE = 3.5; // 1/s, exponential approach (higher = stiffer)
const FOLLOW_ZOOM = 4; // top view, px per metre while following

/** Where the chase camera wants to be for an ambulance pose. */
export function chaseTarget(pose: Pick<Pose, "x" | "z" | "yaw">): { position: Vector3; look: Vector3 } {
  const fx = Math.sin(pose.yaw);
  const fz = Math.cos(pose.yaw);
  return {
    position: new Vector3(pose.x - fx * CHASE_BACK, CHASE_UP, pose.z - fz * CHASE_BACK),
    look: new Vector3(pose.x + fx * CHASE_AHEAD, 1.2, pose.z + fz * CHASE_AHEAD),
  };
}

/** Frame-rate independent exponential smoothing factor. */
export function dampFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * Math.min(dt, 0.1));
}

function mapFrame(network: NetworkMsg, origin: Origin) {
  const [xmin, ymin, xmax, ymax] = network.bounds;
  const [x, , z] = sumoToWorld((xmin + xmax) / 2, (ymin + ymax) / 2, origin);
  return { center: new Vector3(x, 0, z), span: Math.max(xmax - xmin, ymax - ymin) };
}

export function CameraRig({ network, origin }: { network: NetworkMsg; origin: Origin }) {
  const view = useSim((s) => s.view);
  return (
    <>
      <PerspectiveCamera makeDefault={view !== "top"} fov={55} near={0.5} far={6000} position={[0, 400, 500]} />
      <OrthographicCamera makeDefault={view === "top"} near={0.1} far={3000} position={[0, 800, 0.001]} />
      {view === "top" ? (
        <TopRig network={network} origin={origin} />
      ) : (
        <PerspectiveRig network={network} origin={origin} view={view} />
      )}
      <ViewOffset />
    </>
  );
}

/** Shift the projection so the scene centres between the HUD panels. */
function ViewOffset() {
  const camera = useThree((s) => s.camera) as PerspCam | OrthoCam;
  const size = useThree((s) => s.size);
  useEffect(() => {
    const { left, right } = hudInsets(size.width);
    if (left === right) camera.clearViewOffset();
    else camera.setViewOffset(size.width, size.height, -(left - right) / 2, 0, size.width, size.height);
    camera.updateProjectionMatrix();
  }, [camera, size.width, size.height]);
  return null;
}

function PerspectiveRig({ network, origin, view }: { network: NetworkMsg; origin: Origin; view: ViewMode }) {
  const camera = useThree((s) => s.camera);
  const controls = useRef<ComponentRef<typeof MapControls>>(null);
  const look = useRef(new Vector3());
  const size = useThree((s) => s.size);

  const overview = useCallback(() => {
    const { center, span } = mapFrame(network, origin);
    const { left, right } = hudInsets(size.width);
    const free = Math.max(0.4, (size.width - left - right) / size.width);
    const distance = (span * 0.95) / Math.min(1, free * (size.width / size.height));
    return {
      position: new Vector3(center.x - distance * 0.05, distance * 0.62, center.z + distance * 0.72),
      look: center.clone(),
    };
  }, [network, origin, size.height, size.width]);

  // entering orbit: hand the current view to the controls
  useEffect(() => {
    if (view !== "orbit" || !controls.current) return;
    controls.current.target.copy(look.current);
    controls.current.update();
  }, [view]);

  // dev only: scripted screenshots place the orbit camera with window.__efLook(position, target)
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __efLook?: (p: number[], t: number[]) => void };
    w.__efLook = (p, t) => {
      useSim.getState().setView("orbit");
      camera.position.set(p[0]!, p[1]!, p[2]!);
      look.current.set(t[0]!, t[1]!, t[2]!);
      camera.lookAt(look.current);
      controls.current?.target.copy(look.current);
      controls.current?.update();
    };
    return () => {
      delete w.__efLook;
    };
  }, [camera]);

  // a new map (reconnect to another scenario): jump to its overview
  useEffect(() => {
    const target = overview();
    camera.position.copy(target.position);
    look.current.copy(target.look);
    camera.lookAt(look.current);
    controls.current?.target.copy(look.current);
  }, [camera, overview]);

  useFrame((_, dt) => {
    if (view !== "chase") return;
    const pose = livePoses.byId.get(AMBULANCE_ID);
    const target = pose ? chaseTarget(pose) : overview();
    const k = dampFactor(pose ? CHASE_RATE : 1.5, dt);
    camera.position.lerp(target.position, k);
    look.current.lerp(target.look, k);
    camera.lookAt(look.current);
  }, FRAME.camera);

  // Controls exist only in orbit: even disabled, OrbitControls.update() would re-aim the
  // camera at its own target every frame and fight the chase camera.
  if (view !== "orbit") return null;
  return (
    <MapControls
      ref={controls}
      makeDefault
      enableDamping
      maxPolarAngle={Math.PI * 0.47}
      minDistance={8}
      maxDistance={2500}
      onChange={() => {
        if (controls.current) look.current.copy(controls.current.target);
      }}
    />
  );
}

/** 2D map: the whole city, or centred on the ambulance while Follow (F) is on. */
function TopRig({ network, origin }: { network: NetworkMsg; origin: Origin }) {
  const camera = useThree((s) => s.camera) as OrthoCam;
  const size = useThree((s) => s.size);
  const controls = useRef<ComponentRef<typeof MapControls>>(null);
  const following = useRef(false);

  const lookAt = useCallback(
    (x: number, z: number, zoom: number) => {
      camera.zoom = zoom;
      camera.position.set(x, 800, z + 0.001);
      camera.updateProjectionMatrix();
      controls.current?.target.set(x, 0, z);
      controls.current?.update();
    },
    [camera],
  );

  const fitMap = useCallback(() => {
    const { center, span } = mapFrame(network, origin);
    const { left, right } = hudInsets(size.width);
    lookAt(center.x, center.z, Math.min(size.width - left - right, size.height) / (span * 1.08));
  }, [lookAt, network, origin, size.height, size.width]);

  useEffect(() => {
    following.current = false;
    fitMap();
  }, [fitMap]);

  useFrame(() => {
    const { follow } = useSim.getState();
    const ambulance = livePoses.byId.get(AMBULANCE_ID);
    if (follow && ambulance) {
      lookAt(ambulance.x, ambulance.z, following.current ? camera.zoom : FOLLOW_ZOOM);
      following.current = true;
    } else if (following.current) {
      following.current = false;
      fitMap(); // Follow off, or the ambulance is gone (reset): back to the whole map
    }
  }, FRAME.camera);

  return <MapControls ref={controls} makeDefault enableRotate={false} screenSpacePanning />;
}

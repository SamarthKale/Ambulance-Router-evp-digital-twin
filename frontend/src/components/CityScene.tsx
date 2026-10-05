/** The 3D scene (Sprint 5): city, signals, traffic, ambulance, sky and cameras. */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";

import { useAssetStore } from "../assets/loader";
import { originFromBounds, type Origin } from "../simulation/coords";
import { computePoses, livePoses } from "../simulation/poses";
import { useSim, type NetworkMsg } from "../simulation/state";
import { Ambulance } from "./Ambulance";
import { CameraRig } from "./CameraRig";
import { City3D } from "./City3D";
import { buildCityLayout } from "./cityLayout";
import { FRAME, screen } from "./lod";
import { Sky } from "./Sky";
import { LinkDiscs, SignalHeads } from "./TrafficLights";
import { TrafficVehicles } from "./Vehicles";

const INTERACTIVE_AFTER_FRAMES = 30;

export function CityScene({ network }: { network: NetworkMsg }) {
  const origin = useMemo(() => originFromBounds(network.bounds), [network]);
  const layout = useMemo(() => buildCityLayout(network), [network]);
  const view = useSim((s) => s.view);
  const top = view === "top";
  return (
    <>
      <hemisphereLight args={["#dbe8f5", "#5b6347", 1.1]} />
      <directionalLight position={[180, 320, 120]} intensity={2.2} />
      <Sky flat={top} />
      <PoseUpdater origin={origin} />
      <City3D network={network} origin={origin} layout={layout} showLabels={top} />
      <SignalHeads heads={layout.signalHeads} />
      {top && <LinkDiscs network={network} origin={origin} />}
      <TrafficVehicles />
      <Ambulance />
      <CameraRig network={network} origin={origin} />
      <FrameStats />
    </>
  );
}

/** Poses first, then (after the camera rig) the frustum the renderers cull against. */
function PoseUpdater({ origin }: { origin: Origin }) {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __efScene?: unknown };
    w.__efScene = scene; // dev only: performance experiments toggle layers by name
    return () => {
      delete w.__efScene;
    };
  }, [scene]);
  useFrame(() => {
    const { prev, curr } = useSim.getState();
    computePoses(prev, curr, origin, performance.now(), livePoses);
  }, FRAME.poses);
  useFrame(({ camera, size }) => screen.update(camera, size.height), FRAME.cull);
  return null;
}

/** FPS, draw calls and triangles for the HUD; flags the scene interactive for lazy assets. */
function FrameStats() {
  const frames = useRef(0);
  const total = useRef(0);
  const since = useRef(performance.now());
  useFrame(({ gl }) => {
    frames.current += 1;
    total.current += 1;
    if (total.current === INTERACTIVE_AFTER_FRAMES) useAssetStore.getState().setInteractive();
    const now = performance.now();
    if (now - since.current >= 500) {
      const fps = Math.round((frames.current * 1000) / (now - since.current));
      useSim.getState().setRenderStats(fps, gl.info.render.calls, gl.info.render.triangles);
      frames.current = 0;
      since.current = now;
    }
  });
  return null;
}

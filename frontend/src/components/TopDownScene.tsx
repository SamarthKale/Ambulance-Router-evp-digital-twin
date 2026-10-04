/** Top-down view (Sprint 2 walking skeleton): generated roads, signal lamps, box vehicles. */
import { MapControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, type ComponentRef } from "react";
import type { Group, MeshBasicMaterial, OrthographicCamera } from "three";
import { useShallow } from "zustand/react/shallow";

import {
  interpolationAlpha,
  lerp,
  lerpAngleDeg,
  originFromBounds,
  sumoAngleToYaw,
  sumoToWorld,
  type Origin,
  type WorldPoint,
} from "../simulation/coords";
import { AMBULANCE_ID, TICK_MS, useSim, type NetworkMsg, type VehicleMsg } from "../simulation/state";
import { flatPolygonGeometry, ribbonGeometry } from "./geometry";
import { Label } from "./Label";
import { FALLBACK_STYLE, VEHICLE_STYLES, signalColor } from "./vehicleStyles";

const ROAD_Y = 0.02;
const JUNCTION_Y = 0.01;
const LAMP_Y = 0.05;

export function TopDownScene({ network }: { network: NetworkMsg }) {
  const origin = useMemo(() => originFromBounds(network.bounds), [network]);
  return (
    <>
      <ambientLight intensity={0.9} />
      <directionalLight position={[100, 300, 50]} intensity={1.2} />
      <Ground network={network} origin={origin} />
      <Roads network={network} origin={origin} />
      <SignalLamps network={network} origin={origin} />
      <Places network={network} origin={origin} />
      <Vehicles origin={origin} />
      <CameraRig network={network} origin={origin} />
      <FpsMeter />
    </>
  );
}

function Ground({ network, origin }: { network: NetworkMsg; origin: Origin }) {
  const [xmin, ymin, xmax, ymax] = network.bounds;
  const [cx, , cz] = sumoToWorld((xmin + xmax) / 2, (ymin + ymax) / 2, origin);
  return (
    <mesh position={[cx, 0, cz]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[xmax - xmin + 400, ymax - ymin + 400]} />
      <meshBasicMaterial color="#1f2a1f" />
    </mesh>
  );
}

function Roads({ network, origin }: { network: NetworkMsg; origin: Origin }) {
  const geometries = useMemo(() => {
    const lanes = network.lanes.map((lane) =>
      // a 0.3 m gap between lanes reads as the lane marking from above
      ribbonGeometry(lane.shape.map(([x, y]) => sumoToWorld(x, y, origin)), lane.width - 0.3, ROAD_Y),
    );
    const junctions = network.junctions
      .filter((j) => j.shape.length >= 3)
      .map((j) => flatPolygonGeometry(j.shape.map(([x, y]) => sumoToWorld(x, y, origin))));
    return { lanes, junctions };
  }, [network, origin]);

  useEffect(
    () => () => [...geometries.lanes, ...geometries.junctions].forEach((g) => g.dispose()),
    [geometries],
  );

  return (
    <>
      {geometries.junctions.map((geometry, i) => (
        <mesh key={`j${i}`} geometry={geometry} rotation={[-Math.PI / 2, 0, 0]} position={[0, JUNCTION_Y, 0]}>
          <meshBasicMaterial color="#454b54" />
        </mesh>
      ))}
      {geometries.lanes.map((geometry, i) => (
        <mesh key={`l${i}`} geometry={geometry}>
          <meshBasicMaterial color="#3a3f47" />
        </mesh>
      ))}
      {network.signals.map((s) => {
        const junction = network.junctions.find((j) => j.id === s.id);
        if (!junction) return null;
        const xs = junction.shape.map((p) => p[0]);
        const ys = junction.shape.map((p) => p[1]);
        const position = sumoToWorld(
          (Math.min(...xs) + Math.max(...xs)) / 2,
          (Math.min(...ys) + Math.max(...ys)) / 2,
          origin,
          1,
        );
        return <Label key={s.id} text={s.id} position={position} background="#000000a0" />;
      })}
    </>
  );
}

interface Lamp {
  tls: string;
  index: number;
  position: WorldPoint;
}

/** One small lamp per signal link at its stop line, coloured by that link's state. */
function SignalLamps({ network, origin }: { network: NetworkMsg; origin: Origin }) {
  const lamps = useMemo(() => {
    const laneShapes = new Map(network.lanes.map((l) => [l.id, l.shape]));
    const result: Lamp[] = [];
    for (const signal of network.signals) {
      const perLane = new Map<string, number>();
      for (const link of signal.links) {
        const shape = laneShapes.get(link.fromLane);
        if (!shape || shape.length < 2) continue;
        const [x2, y2] = shape[shape.length - 1]!;
        const [x1, y1] = shape[shape.length - 2]!;
        const len = Math.hypot(x2 - x1, y2 - y1) || 1;
        const slot = perLane.get(link.fromLane) ?? 0;
        perLane.set(link.fromLane, slot + 1);
        const back = 1.0 + 1.6 * slot; // stack the links of one lane back from the stop line
        const x = x2 - ((x2 - x1) / len) * back;
        const y = y2 - ((y2 - y1) / len) * back;
        result.push({ tls: signal.id, index: link.index, position: sumoToWorld(x, y, origin, LAMP_Y) });
      }
    }
    return result;
  }, [network, origin]);

  const states = useSim(useShallow((s) => s.curr?.msg.signals.map((sig) => sig.state) ?? []));
  const order = network.signals.map((s) => s.id);
  return (
    <>
      {lamps.map((lamp) => {
        const state = states[order.indexOf(lamp.tls)]?.[lamp.index] ?? "o";
        return (
          <mesh key={`${lamp.tls}:${lamp.index}`} position={lamp.position} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[0.65, 16]} />
            <meshBasicMaterial color={signalColor(state)} />
          </mesh>
        );
      })}
    </>
  );
}

function Places({ network, origin }: { network: NetworkMsg; origin: Origin }) {
  const depot = sumoToWorld(network.depot.x, network.depot.y, origin, 0.04);
  const hospital = sumoToWorld(network.hospital.x, network.hospital.y, origin, 0.04);
  return (
    <>
      <mesh position={depot} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[8, 8]} />
        <meshBasicMaterial color="#2563eb" transparent opacity={0.6} />
      </mesh>
      <Label text="Depot" position={[depot[0], 1, depot[2] - 10]} background="#1d4ed8" />
      <mesh position={hospital} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[10, 10]} />
        <meshBasicMaterial color="#dc2626" transparent opacity={0.6} />
      </mesh>
      <Label text="Hospital" position={[hospital[0], 1, hospital[2] - 10]} background="#b91c1c" />
    </>
  );
}

function Vehicles({ origin }: { origin: Origin }) {
  // Re-render only when vehicles appear or disappear; poses are set per frame below.
  const keys = useSim(useShallow((s) => s.curr?.msg.vehicles.map((v) => `${v.id}|${v.type}`) ?? []));
  const groups = useRef(new Map<string, Group>());

  useFrame(() => {
    const { prev, curr } = useSim.getState();
    if (!curr) return;
    const alpha = interpolationAlpha(performance.now(), curr.receivedAt, TICK_MS);
    const before = new Map<string, VehicleMsg>(prev?.msg.vehicles.map((v) => [v.id, v]) ?? []);
    for (const v of curr.msg.vehicles) {
      const group = groups.current.get(v.id);
      if (!group) continue;
      const a = before.get(v.id) ?? v;
      const [x, y, z] = sumoToWorld(lerp(a.x, v.x, alpha), lerp(a.y, v.y, alpha), origin);
      group.position.set(x, y, z);
      group.rotation.y = sumoAngleToYaw(lerpAngleDeg(a.angle, v.angle, alpha));
    }
  });

  return (
    <>
      {keys.map((key) => {
        const [id, type] = key.split("|") as [string, string];
        return (
          <group
            key={key}
            ref={(group) => {
              if (group) groups.current.set(id, group);
              else groups.current.delete(id);
            }}
          >
            {id === AMBULANCE_ID ? <AmbulanceBox /> : <VehicleBox type={type} />}
          </group>
        );
      })}
    </>
  );
}

function VehicleBox({ type }: { type: string }) {
  const style = VEHICLE_STYLES[type] ?? FALLBACK_STYLE;
  const [w, h, l] = style.size;
  return (
    <mesh position={[0, h / 2, 0]}>
      <boxGeometry args={[w, h, l]} />
      <meshLambertMaterial color={style.color} />
    </mesh>
  );
}

function AmbulanceBox() {
  const [w, h, l] = VEHICLE_STYLES.ambulance!.size;
  const left = useRef<MeshBasicMaterial>(null);
  const right = useRef<MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    const on = Math.floor(clock.elapsedTime * 4) % 2 === 0; // siren flashes at 2 Hz
    left.current?.color.set(on ? "#ef4444" : "#1d4ed8");
    right.current?.color.set(on ? "#1d4ed8" : "#ef4444");
  });
  return (
    <>
      <mesh position={[0, h / 2, 0]}>
        <boxGeometry args={[w, h, l]} />
        <meshLambertMaterial color={VEHICLE_STYLES.ambulance!.color} />
      </mesh>
      <mesh position={[0, h + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w * 0.9, 1.0]} />
        <meshBasicMaterial color="#dc2626" />
      </mesh>
      <mesh position={[-w / 4, h + 0.02, l / 4]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w / 2.2, 0.8]} />
        <meshBasicMaterial ref={left} />
      </mesh>
      <mesh position={[w / 4, h + 0.02, l / 4]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w / 2.2, 0.8]} />
        <meshBasicMaterial ref={right} />
      </mesh>
    </>
  );
}

const FOLLOW_ZOOM = 4; // px per metre while following the ambulance

/** Show the whole map; keep the ambulance centred while it exists and Follow is on (F). */
function CameraRig({ network, origin }: { network: NetworkMsg; origin: Origin }) {
  const camera = useThree((s) => s.camera) as OrthographicCamera;
  const size = useThree((s) => s.size);
  const controls = useRef<ComponentRef<typeof MapControls>>(null);
  const following = useRef(false);

  const lookAt = useCallback(
    (x: number, z: number, zoom: number) => {
      camera.zoom = zoom;
      camera.position.set(x, camera.position.y, z + 0.001);
      camera.updateProjectionMatrix();
      controls.current?.target.set(x, 0, z);
      controls.current?.update();
    },
    [camera],
  );

  const fitMap = useCallback(() => {
    const [xmin, ymin, xmax, ymax] = network.bounds;
    const span = Math.max(xmax - xmin, ymax - ymin) * 1.1;
    const [x, , z] = sumoToWorld((xmin + xmax) / 2, (ymin + ymax) / 2, origin);
    lookAt(x, z, Math.min(size.width, size.height) / span);
  }, [lookAt, network, origin, size.height, size.width]);

  useEffect(() => {
    if (!following.current) fitMap();
  }, [fitMap]);

  useFrame(() => {
    const { follow, curr } = useSim.getState();
    const ambulance = curr?.msg.vehicles.find((v) => v.id === AMBULANCE_ID);
    if (follow && ambulance) {
      const [x, , z] = sumoToWorld(ambulance.x, ambulance.y, origin);
      lookAt(x, z, following.current ? camera.zoom : FOLLOW_ZOOM);
      following.current = true;
    } else if (following.current) {
      following.current = false;
      if (!ambulance) fitMap(); // e.g. after a reset: back to the overview
    }
  });

  return <MapControls ref={controls} enableRotate={false} screenSpacePanning makeDefault />;
}

function FpsMeter() {
  const frames = useRef(0);
  const since = useRef(performance.now());
  useFrame(() => {
    frames.current += 1;
    const now = performance.now();
    if (now - since.current >= 500) {
      useSim.getState().setFps(Math.round((frames.current * 1000) / (now - since.current)));
      frames.current = 0;
      since.current = now;
    }
  });
  return null;
}

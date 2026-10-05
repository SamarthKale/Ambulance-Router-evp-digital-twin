/**
 * The city: ground layers, roads and markings generated from the network, plus every
 * delivered model placed by the city layout (instanced per model).
 *
 * Flat ground layers don't write depth and are drawn in a fixed order (renderOrder), so
 * pavement, road and paint never z-fight however far the camera is.
 */
import { useEffect, useMemo } from "react";
import { BufferGeometry, CanvasTexture, Color, SRGBColorSpace } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useShallow } from "zustand/react/shallow";

import { useAsset } from "../assets/loader";
import type { AssetKey } from "../assets/manifest";
import { sumoToWorld, type Origin } from "../simulation/coords";
import { useSim, type NetworkMsg } from "../simulation/state";
import { StaticInstances } from "./Asset";
import type { CityLayout, LotKind } from "./cityLayout";
import {
  groundPolygonGeometry,
  rectsGeometry,
  ribbonGeometry,
  stripBoxesGeometry,
  stripsGeometry,
} from "./geometry";
import { Label } from "./Label";
import { CONTROL_COLORS } from "./vehicleStyles";

const COLORS = {
  ground: "#76865a",
  sidewalk: "#bdb7aa",
  road: "#3b3f46",
  junction: "#41454c",
  paint: "#f1f1ee",
  median: "#c9c4b6",
  path: "#cbbf9f",
};
const LOT_COLORS: Record<LotKind, string> = {
  paved: "#a7a297",
  residential: "#9fa08f",
  park: "#5f8a3e",
  hospital: "#c7c2b5",
};

// draw order of the flat layers (all before the 3D models)
const ORDER = { ground: -10, sidewalk: -9, lot: -8, path: -7.5, road: -7, paint: -6, rings: -5 };

function useDisposable<T extends { dispose: () => void }>(make: () => T, deps: unknown[]): T {
  const value = useMemo(make, deps);
  useEffect(() => () => value.dispose(), [value]);
  return value;
}

export function City3D({
  network,
  origin,
  layout,
  showLabels,
}: {
  network: NetworkMsg;
  origin: Origin;
  layout: CityLayout;
  showLabels: boolean;
}) {
  return (
    <group name="city">
      <GroundLayers network={network} origin={origin} layout={layout} />
      <Medians layout={layout} />
      <JunctionRings network={network} origin={origin} />
      {(Object.entries(layout.props) as [AssetKey, CityLayout["props"][AssetKey]][]).map(([key, placements]) =>
        placements && placements.length ? <StaticInstances key={key} id={key} placements={placements} /> : null,
      )}
      <Hospital layout={layout} />
      <Places network={network} origin={origin} />
      {showLabels && <JunctionLabels network={network} origin={origin} />}
    </group>
  );
}

/**
 * The ground is flat and faces the sun the same way everywhere, so per-pixel lighting would
 * compute one value over and over: the layers are unlit, in colours pre-multiplied by what
 * the scene's lights give an upward-facing surface (hemisphere + sun, measured against the
 * lit version). Fog still applies.
 */
const GROUND_LIGHT = 0.88;
const lit = (hex: string) => new Color(hex).multiplyScalar(GROUND_LIGHT);

function GroundLayers({ network, origin, layout }: { network: NetworkMsg; origin: Origin; layout: CityLayout }) {
  const ground = useDisposable(() => rectsGeometry(layout.ground), [layout]);
  const sidewalks = useDisposable(() => rectsGeometry(layout.sidewalks), [layout]);
  const lots = useDisposable(
    () => rectsGeometry(layout.lots.map((l) => l.rect), 0, layout.lots.map((l) => lit(LOT_COLORS[l.kind]))),
    [layout],
  );
  const roads = useDisposable(() => {
    const lanes = network.lanes.map((lane) =>
      ribbonGeometry(lane.shape.map(([x, y]) => sumoToWorld(x, y, origin)), lane.width + 0.02),
    );
    const junctions = network.junctions
      .filter((j) => j.shape.length >= 3)
      .map((j) => {
        const g = groundPolygonGeometry(j.shape.map(([x, y]) => sumoToWorld(x, y, origin)));
        g.deleteAttribute("uv");
        return g;
      });
    const parts = [...lanes, ...junctions];
    const merged = mergeGeometries(parts, false) ?? new BufferGeometry();
    parts.forEach((p) => p.dispose());
    return merged;
  }, [network, origin]);
  const paint = useDisposable(() => stripsGeometry([...layout.paint, ...layout.zebras]), [layout]);
  const paths = useDisposable(() => stripsGeometry(layout.paths), [layout]);

  return (
    <group name="ground">
      <mesh geometry={ground} renderOrder={ORDER.ground}>
        <meshBasicMaterial color={lit(COLORS.ground)} depthWrite={false} />
      </mesh>
      <mesh geometry={sidewalks} renderOrder={ORDER.sidewalk}>
        <meshBasicMaterial color={lit(COLORS.sidewalk)} depthWrite={false} />
      </mesh>
      <mesh geometry={lots} renderOrder={ORDER.lot}>
        <meshBasicMaterial vertexColors depthWrite={false} />
      </mesh>
      <mesh geometry={paths} renderOrder={ORDER.path}>
        <meshBasicMaterial color={lit(COLORS.path)} depthWrite={false} />
      </mesh>
      <mesh geometry={roads} renderOrder={ORDER.road}>
        <meshBasicMaterial color={lit(COLORS.road)} depthWrite={false} />
      </mesh>
      <mesh geometry={paint} renderOrder={ORDER.paint}>
        <meshBasicMaterial color={lit(COLORS.paint)} depthWrite={false} />
      </mesh>
    </group>
  );
}

function Medians({ layout }: { layout: CityLayout }) {
  const geometry = useDisposable(() => stripBoxesGeometry(layout.medians, 0.22), [layout]);
  return (
    <mesh geometry={geometry}>
      <meshLambertMaterial color={COLORS.median} />
    </mesh>
  );
}

/** A ring around each junction while the safety controller (not the program) drives it. */
function JunctionRings({ network, origin }: { network: NetworkMsg; origin: Origin }) {
  const rings = useMemo(
    () =>
      network.signals.flatMap((s) => {
        const junction = network.junctions.find((j) => j.id === s.id);
        if (!junction) return [];
        const xs = junction.shape.map((p) => p[0]);
        const ys = junction.shape.map((p) => p[1]);
        const radius = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2;
        const center = sumoToWorld((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, origin, 0.05);
        return [{ id: s.id, center, radius: radius + 2 }];
      }),
    [network, origin],
  );
  const controls = useSim(useShallow((s) => s.curr?.msg.signals.map((sig) => sig.control) ?? []));
  const order = network.signals.map((s) => s.id);
  return (
    <>
      {rings.map((ring) => {
        const color = CONTROL_COLORS[controls[order.indexOf(ring.id)] ?? "program"];
        if (!color) return null;
        return (
          <mesh key={ring.id} position={ring.center} rotation={[-Math.PI / 2, 0, 0]} renderOrder={ORDER.rings}>
            <ringGeometry args={[ring.radius, ring.radius + 2.5, 48]} />
            <meshBasicMaterial color={color} transparent opacity={0.85} depthWrite={false} toneMapped={false} />
          </mesh>
        );
      })}
    </>
  );
}

/** The hospital model by the hospital stop, with a red-cross sign visible from far away. */
function Hospital({ layout }: { layout: CityLayout }) {
  const asset = useAsset("hospital");
  const cross = useDisposable(() => crossTexture(), []);
  const h = layout.hospital;
  if (!h) return null;
  return (
    <group position={[h.x, 0, h.z]} rotation={[0, h.yaw, 0]}>
      {asset.parts.map((part, i) => (
        <mesh key={i} geometry={part.geometry} material={part.material} />
      ))}
      <sprite position={[0, asset.size[1] + 7, 0]} scale={[11, 11, 1]}>
        <spriteMaterial map={cross} toneMapped={false} />
      </sprite>
    </group>
  );
}

function crossTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.roundRect(4, 4, 120, 120, 18);
  ctx.fill();
  ctx.fillStyle = "#dc2626";
  ctx.fillRect(48, 18, 32, 92);
  ctx.fillRect(18, 48, 92, 32);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function Places({ network, origin }: { network: NetworkMsg; origin: Origin }) {
  const depot = sumoToWorld(network.depot.x, network.depot.y, origin, 0.05);
  const hospital = sumoToWorld(network.hospital.x, network.hospital.y, origin, 0.05);
  return (
    <>
      <mesh position={depot} rotation={[-Math.PI / 2, 0, 0]} renderOrder={ORDER.rings}>
        <planeGeometry args={[8, 3]} />
        <meshBasicMaterial color="#2563eb" transparent opacity={0.55} depthWrite={false} />
      </mesh>
      <Label text="Depot" position={[depot[0], 7, depot[2]]} background="#1d4ed8" />
      <mesh position={hospital} rotation={[-Math.PI / 2, 0, 0]} renderOrder={ORDER.rings}>
        <planeGeometry args={[8, 3]} />
        <meshBasicMaterial color="#dc2626" transparent opacity={0.55} depthWrite={false} />
      </mesh>
      <Label text="Hospital" position={[hospital[0], 7, hospital[2]]} background="#b91c1c" />
    </>
  );
}

function JunctionLabels({ network, origin }: { network: NetworkMsg; origin: Origin }) {
  return (
    <>
      {network.signals.map((s) => {
        const junction = network.junctions.find((j) => j.id === s.id);
        if (!junction) return null;
        const xs = junction.shape.map((p) => p[0]);
        const ys = junction.shape.map((p) => p[1]);
        const position = sumoToWorld((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, origin, 1);
        return <Label key={s.id} text={s.id} position={position} background="#000000a0" />;
      })}
    </>
  );
}

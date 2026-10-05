/**
 * The suggested route drawn on the road (advisory: it never steers a manual drive), from
 * the ambulance to the hospital, with chevrons moving towards the hospital, plus a label at
 * the next junction where the route turns.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Color, ShaderMaterial } from "three";
import { useShallow } from "zustand/react/shallow";

import { sumoToWorld, type Origin } from "../simulation/coords";
import { livePoses } from "../simulation/poses";
import { AMBULANCE_ID, useSim, type NetworkMsg, type TurnKind } from "../simulation/state";
import { Label } from "./Label";
import { cumulative, distanceAlong, routePolyline, routeRibbon } from "./routePath";

const WIDTH = 1.8; // m
const HEIGHT = 0.12; // m above the road, below vehicles
export const ROUTE_COLOR = "#22d3ee";
const OFF_PLAN_COLOR = "#f59e0b"; // the ambulance is about to leave the suggested route
export const TURN_ARROW: Record<TurnKind, string> = { left: "↰", straight: "↑", right: "↱", uturn: "↶" };

const vertex = /* glsl */ `
  attribute float along;
  varying float vAlong;
  void main() {
    vAlong = along;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const fragment = /* glsl */ `
  uniform vec3 color;
  uniform float start;
  uniform float time;
  varying float vAlong;
  void main() {
    if (vAlong < start) discard;  // the part already driven
    float chevron = fract((vAlong - time * 12.0) / 9.0);
    float alpha = 0.55 + 0.35 * smoothstep(0.55, 0.75, chevron) * (1.0 - smoothstep(0.85, 1.0, chevron));
    float fadeIn = smoothstep(start, start + 6.0, vAlong);
    gl_FragColor = vec4(color, alpha * fadeIn);
  }
`;

export function RouteOverlay({ network, origin }: { network: NetworkMsg; origin: Origin }) {
  const { edges, follows, next } = useSim(
    useShallow((s) => {
      const route = s.curr?.msg.route;
      return {
        edges: route?.edges.join(" ") ?? "",
        follows: route?.follows ?? true,
        next: route?.turns[0] ? `${route.turns[0].junction}|${route.turns[0].turn}` : "",
      };
    }),
  );
  const path = useMemo(() => {
    if (!edges) return null;
    const points = routePolyline(network, origin, edges.split(" "));
    return points.length > 1 ? { points, along: cumulative(points), geometry: routeRibbon(points, WIDTH, HEIGHT) } : null;
  }, [edges, network, origin]);
  useEffect(() => () => path?.geometry.dispose(), [path]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment,
        uniforms: { color: { value: new Color(ROUTE_COLOR) }, start: { value: 0 }, time: { value: 0 } },
        transparent: true,
        depthWrite: false,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => {
    (material.uniforms.color!.value as Color).set(follows ? ROUTE_COLOR : OFF_PLAN_COLOR);
  }, [follows, material]);

  useFrame(({ clock }) => {
    material.uniforms.time!.value = clock.elapsedTime;
    const pose = livePoses.byId.get(AMBULANCE_ID);
    if (path && pose) material.uniforms.start!.value = distanceAlong(path.points, path.along, pose.x, pose.z);
  });

  const label = useMemo(() => {
    if (!next) return null;
    const [junctionId, turn] = next.split("|") as [string, TurnKind];
    const junction = network.junctions.find((j) => j.id === junctionId);
    if (!junction || junction.shape.length === 0) return null;
    const xs = junction.shape.map((p) => p[0]);
    const ys = junction.shape.map((p) => p[1]);
    const position = sumoToWorld((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, origin, 6);
    return { position, text: `${TURN_ARROW[turn]} ${turn.toUpperCase()} at ${junctionId}` };
  }, [next, network, origin]);

  if (!path) return null;
  return (
    <group name="route">
      <mesh geometry={path.geometry} material={material} renderOrder={-5.5} frustumCulled={false} />
      {label && <Label text={label.text} position={label.position} background={follows ? "#0e7490" : "#b45309"} />}
    </group>
  );
}

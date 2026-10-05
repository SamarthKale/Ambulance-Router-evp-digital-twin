/**
 * Accidents (Sprint 8). The wreck is a SUMO vehicle held in its lane (traffic reacts to it);
 * the backend leaves it out of the vehicle list and reports it as an incident, drawn here
 * with the delivered props: wrecked car, barrier, cone taper, road-block marker, a short
 * impact flash and a label.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Group } from "three";

import { useAsset } from "../assets/loader";
import { sumoAngleToYaw, sumoToWorld, type Origin } from "../simulation/coords";
import { useSim, type IncidentMsg } from "../simulation/state";
import { Asset } from "./Asset";
import { incidentProps } from "./incidentLayout";
import { Label } from "./Label";

const FLASH_S = 4; // simulated seconds the impact marker shows after the accident
const LABEL_COLOR = "#b91c1c";

export function Incidents({ origin, lefthand }: { origin: Origin; lefthand: boolean }) {
  // Re-render only when the set of incidents changes, not on every tick.
  const key = useSim((s) => s.curr?.msg.incidents.map((i) => i.id).join(" ") ?? "");
  const incidents = useMemo(
    () => (key ? (useSim.getState().curr?.msg.incidents ?? []) : []),
    [key],
  );
  // Fetch the heavy wreck model once the scene is interactive, before the first accident.
  useAsset("wrecked_car");
  return (
    <>
      {incidents.map((incident) => (
        <Accident key={incident.id} incident={incident} origin={origin} lefthand={lefthand} />
      ))}
    </>
  );
}

function Accident({ incident, origin, lefthand }: { incident: IncidentMsg; origin: Origin; lefthand: boolean }) {
  const position = sumoToWorld(incident.x, incident.y, origin);
  const props = useMemo(() => incidentProps(incident.lane, lefthand), [incident.lane, lefthand]);
  const flashing = useSim((s) => (s.curr?.msg.t ?? Infinity) - incident.since < FLASH_S);
  return (
    <group position={position} rotation-y={sumoAngleToYaw(incident.angle)} name={`incident ${incident.id}`}>
      {props.map((p, i) => (
        <group key={i} position={p.position} rotation-y={p.rotationY}>
          <Asset id={p.asset} />
        </group>
      ))}
      {flashing && <ImpactFlash />}
      <Label text={`ACCIDENT · ${incident.edge}`} position={[0, 4.5, 0]} background={LABEL_COLOR} />
    </group>
  );
}

function ImpactFlash() {
  const group = useRef<Group>(null);
  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    const pulse = 0.8 + 0.25 * Math.sin(clock.elapsedTime * 9);
    g.scale.setScalar(pulse);
  });
  return (
    <group ref={group} position={[0, 1.2, 0]}>
      <Asset id="explosion_marker" />
    </group>
  );
}

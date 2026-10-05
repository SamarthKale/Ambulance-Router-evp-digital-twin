/**
 * Signal heads: one delivered traffic-light model per approach at the stop line, its
 * lamps lit from that approach's links. Instanced: the whole city is a few draw calls.
 * In the top view, one small disc per link shows each movement's own state.
 */
import { useEffect, useMemo, useRef } from "react";
import { Color, InstancedMesh, MeshBasicMaterial, Object3D } from "three";
import { CircleGeometry } from "three";

import { useAsset } from "../assets/loader";
import { useSim, type NetworkMsg, type SignalMsg } from "../simulation/state";
import { sumoToWorld, type Origin } from "../simulation/coords";
import { useInstancedAsset } from "./Asset";
import { approachLamp, type SignalHead } from "./cityLayout";
import { signalColor } from "./vehicleStyles";

const LAMPS = ["lamp_red", "lamp_yellow", "lamp_green"] as const;
const LIT: Record<(typeof LAMPS)[number], Color> = {
  lamp_red: new Color("#ff2d20").multiplyScalar(2.2),
  lamp_yellow: new Color("#ffc21a").multiplyScalar(2.2),
  lamp_green: new Color("#1aff5c").multiplyScalar(2.2),
};
const DIM: Record<(typeof LAMPS)[number], Color> = {
  lamp_red: new Color("#2b0c0a"),
  lamp_yellow: new Color("#2b230a"),
  lamp_green: new Color("#0a2b12"),
};
const LAMP_OF = { red: "lamp_red", yellow: "lamp_yellow", green: "lamp_green" } as const;

function signalStates(signals: SignalMsg[] | undefined): Map<string, string> {
  return new Map((signals ?? []).map((s) => [s.id, s.state]));
}

export function SignalHeads({ heads }: { heads: SignalHead[] }) {
  const asset = useAsset("traffic_light");
  const instanced = useInstancedAsset(asset, Math.max(1, heads.length), { lampParts: LAMPS });

  useEffect(() => {
    heads.forEach((h, i) => instanced.setTransform(i, h.placement.x, 0, h.placement.z, h.placement.yaw));
    instanced.commit(heads.length);
    let last = "";
    const paint = (signals: SignalMsg[] | undefined) => {
      const key = signals?.map((s) => s.state).join("|") ?? "";
      if (key === last) return;
      last = key;
      const states = signalStates(signals);
      heads.forEach((h, i) => {
        const lamp = approachLamp(states.get(h.junction) ?? "", h.links);
        for (const part of LAMPS) {
          instanced.setLamp(part, i, lamp !== "off" && LAMP_OF[lamp] === part ? LIT[part] : DIM[part]);
        }
      });
      instanced.commitLamps();
    };
    paint(useSim.getState().curr?.msg.signals);
    return useSim.subscribe((s) => paint(s.curr?.msg.signals));
  }, [heads, instanced]);

  return <primitive object={instanced} />;
}

interface Disc {
  tls: string;
  index: number;
  x: number;
  z: number;
}

/** Top view: one disc per signal link at the stop line (a junction has no single colour). */
export function LinkDiscs({ network, origin }: { network: NetworkMsg; origin: Origin }) {
  const discs = useMemo(() => {
    const laneShapes = new Map(network.lanes.map((l) => [l.id, l.shape]));
    const result: Disc[] = [];
    for (const signal of network.signals) {
      const perLane = new Map<string, number>();
      for (const link of signal.links) {
        const shape = laneShapes.get(link.fromLane);
        if (!shape || shape.length < 2) continue;
        const [x2, y2] = shape[shape.length - 1]!;
        const [x1, y1] = shape[shape.length - 2]!;
        const d = Math.hypot(x2 - x1, y2 - y1) || 1;
        const slot = perLane.get(link.fromLane) ?? 0;
        perLane.set(link.fromLane, slot + 1);
        const back = 2.0 + 1.6 * slot; // stack one lane's links back from the stop line
        const [x, , z] = sumoToWorld(x2 - ((x2 - x1) / d) * back, y2 - ((y2 - y1) / d) * back, origin);
        result.push({ tls: signal.id, index: link.index, x, z });
      }
    }
    return result;
  }, [network, origin]);

  const mesh = useRef<InstancedMesh>(null);
  const resources = useMemo(
    () => ({
      geometry: new CircleGeometry(0.65, 16).rotateX(-Math.PI / 2),
      material: new MeshBasicMaterial({ color: "#ffffff", depthWrite: false, toneMapped: false }),
    }),
    [],
  );
  useEffect(() => () => {
    resources.geometry.dispose();
    resources.material.dispose();
  }, [resources]);

  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const o = new Object3D();
    discs.forEach((d, i) => {
      o.position.set(d.x, 0.06, d.z);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
    const color = new Color();
    const paint = (signals: SignalMsg[] | undefined) => {
      const states = signalStates(signals);
      discs.forEach((d, i) => m.setColorAt(i, color.set(signalColor(states.get(d.tls)?.[d.index] ?? "o"))));
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    };
    paint(useSim.getState().curr?.msg.signals);
    return useSim.subscribe((s) => paint(s.curr?.msg.signals));
  }, [discs]);

  return (
    <instancedMesh
      key={discs.length}
      ref={mesh}
      args={[resources.geometry, resources.material, Math.max(1, discs.length)]}
      renderOrder={-5}
    />
  );
}

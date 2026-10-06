/** Colours of the map. Heat colours scale a recorded count or speed; they do not estimate anything. */
import type { Heat } from "./replayStore";
import type { Lamp } from "./playback";

export const FREE_FLOW_MS = 13.89; // the scenario's speed limit (the net's lanes)
export const HEAT_FULL_HALTING = 8; // halted vehicles on one road at full colour
export const HEAT_FULL_VEHICLES = 14;

export const COLORS = {
  ground: "#0b1220",
  road: "#334155",
  roadEdge: "#1e293b",
  junction: "#3b4a61",
  routeNow: "#38bdf8",
  routeOld: "#fbbf24",
  routeRef: "#94a3b8",
  actual: "#38bdf8",
  ghost: "#cbd5e1",
  preempt: "#22d3ee",
  clearing: "#f59e0b",
  recovery: "#a78bfa",
  label: "#cbd5e1",
  incident: "#f97316",
} as const;

export const LAMP_COLOR: Record<Lamp, string> = { green: "#22c55e", yellow: "#facc15", red: "#ef4444" };

function mix(a: [number, number, number], b: [number, number, number], u: number): string {
  const k = Math.min(1, Math.max(0, u));
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** The overlay colour of one road for a heat mode, or null for no overlay (value 0 or no mode). */
export function heatColor(mode: Heat, halting: number, vehicles: number, speed: number): string | null {
  switch (mode) {
    case "off":
      return null;
    case "halting":
      return halting <= 0 ? null : mix([250, 204, 21], [220, 38, 38], Math.min(1, halting / HEAT_FULL_HALTING));
    case "vehicles":
      return vehicles <= 0 ? null : mix([30, 64, 120], [56, 189, 248], Math.min(1, vehicles / HEAT_FULL_VEHICLES));
    case "speed":
      return vehicles <= 0 ? null : mix([220, 38, 38], [34, 197, 94], Math.min(1, speed / FREE_FLOW_MS));
  }
}

export const HEAT_LEGEND: Record<Exclude<Heat, "off">, string> = {
  halting: "halted vehicles per road (0 → 8+)",
  vehicles: "vehicles per road (0 → 14+)",
  speed: "mean speed (stopped → 50 km/h)",
};

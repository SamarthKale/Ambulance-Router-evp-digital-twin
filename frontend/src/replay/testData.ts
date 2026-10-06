/** Test helpers: a small synthetic run, and the real recorded runs from experiments/telemetry. */
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import type { NetworkMsg, ReplayRunMsg, ReplaySummaryMsg } from "../simulation/state";

const REPO = new URL("../../../", import.meta.url);

function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** The API serves the stored snake_case telemetry as camelCase: do the same for object keys. */
export function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [camel(k), camelize(v)]));
  }
  return value;
}

export const SUMMARY: ReplaySummaryMsg = {
  origin: "w0_A0",
  destination: "B1_e1",
  dispatchS: 310,
  tripM: 1000,
  arrived: true,
  valid: true,
  signalProgram: "tuned",
  cycleS: 34.7,
  travelS: 10,
  waitS: 0,
  stops: 0,
  redStops: 0,
  redCrossings: 0,
  approachClearS: null,
  queueMean: 0.5,
  bgTimeLossS: 1000,
  preemptions: 1,
  routeChanges: 0,
  violations: 0,
  collisions: 0,
  emergencyBrakings: 0,
  teleports: 0,
  ambulanceCollisions: null,
};

/** 10 s run: the ambulance drives east along w0_A0 then A0_B0; one junction is preempted 3..8 s. */
export function fakeRun(over: Partial<ReplayRunMsg> = {}): ReplayRunMsg {
  return {
    v: 1,
    schemaVersion: 1,
    id: "basic_static/grid4x4_x1.5_seed001",
    scenario: "grid4x4",
    scale: 1.5,
    seed: 1,
    arm: "basic_static",
    strategy: "basic",
    routing: "static",
    dispatchS: 310,
    durationS: 12,
    arrived: true,
    missionTime: 10,
    ambulanceEdges: ["w0_A0", "A0_B0"],
    ambulance: [
      [0, 0, 200, 90, 0, 0, 0],
      [5, 100, 200, 90, 20, 0, 0],
      [10, 200, 210, 0, 10, 1, 1],
      [12, 200, 210, 0, 0, 1, 1],
    ],
    status: [
      [0, 10, 200, "A0", "r"],
      [5, 5, 100, "B0", "G"],
      [10, null, null, null, null],
    ],
    routes: [
      { t: 0, edges: ["w0_A0", "A0_B0"], eta: 10, routing: "static" },
      { t: 6, edges: ["A0_B0", "B0_e0"], eta: 5, routing: "static" },
    ],
    signals: {
      ids: ["A0", "B0"],
      initial: ["rrGG", "GGrr"],
      initialControl: ["program", "program"],
      changes: [
        [3, 0, "yyGG", "clearing"],
        [5, 0, "rrrr", "clearing"],
        [6, 0, "GGrr", "preempted"],
        [8, 0, "rrGG", "recovering"],
        [9, 0, "rrGG", "program"],
      ],
    },
    events: [
      { t: 0, kind: "dispatch", junction: null, edge: null, text: "ambulance dispatched", accepted: null },
      { t: 3, kind: "preempt", junction: "A0", edge: null, text: "clearing A0", accepted: true },
      { t: 4, kind: "route_review", junction: "A0", edge: null, text: "route via ...", accepted: true },
      { t: 6, kind: "reroute", junction: null, edge: null, text: "route changed", accepted: null },
      { t: 10, kind: "arrival", junction: null, edge: null, text: "arrived after 10.0 s", accepted: null },
    ],
    edges: {
      ids: ["w0_A0", "A0_B0"],
      intervalS: 5,
      samples: [
        { t: 0, halting: [0, 3], vehicles: [2, 5], speed: [9, 2] },
        { t: 5, halting: [1, 0], vehicles: [3, 4], speed: [8, 6] },
        { t: 10, halting: [0, 2], vehicles: [1, 6], speed: [10, 4] },
      ],
    },
    traffic: {
      intervalS: 1,
      ids: ["a", "b", "c"],
      types: ["car_sedan", "car_sedan", "car_hatchback"],
      samples: [
        [0, [0, 10, 200, 90, 1, 50, 200, 90]],
        [1, [0, 20, 200, 90, 2, 50, 210, 0]],
        [2, [0, 30, 200, 90, 2, 60, 210, 0]],
      ],
    },
    incidents: [],
    summary: SUMMARY,
    verification: { matchesRecorded: true, checked: 17, differences: [] },
    recordedWith: { gitSha: "a".repeat(40), gitDirty: false, sumoVersion: "SUMO", createdAt: "2026-10-06T00:00:00+00:00" },
    ...over,
  };
}

export const REAL_DIR = new URL("experiments/telemetry/", REPO);

export function hasRealData(): boolean {
  return existsSync(new URL("index.json", REAL_DIR));
}

export function loadRealRun(arm: string, key: string): ReplayRunMsg {
  const raw = gunzipSync(readFileSync(new URL(`${arm}/${key}.json.gz`, REAL_DIR))).toString("utf-8");
  const data = camelize(JSON.parse(raw)) as Record<string, unknown>;
  const strategy = arm.replace(/_(static|dynamic)$/, "");
  const routing = arm.endsWith("dynamic") ? "dynamic" : "static";
  const match = /^(\w+?)_x([\d.]+)_seed(\d+)$/.exec(key);
  return {
    v: 1,
    id: `${arm}/${key}`,
    scenario: match?.[1] ?? "",
    scale: Number(match?.[2]),
    seed: Number(match?.[3]),
    arm,
    strategy,
    routing,
    summary: null,
    ...data,
  } as unknown as ReplayRunMsg;
}

export function loadRealNetwork(scenario = "grid4x4"): NetworkMsg {
  const path = new URL(`frontend/src/components/fixtures/network.${scenario}.json`, REPO);
  return JSON.parse(readFileSync(path, "utf-8")) as NetworkMsg;
}

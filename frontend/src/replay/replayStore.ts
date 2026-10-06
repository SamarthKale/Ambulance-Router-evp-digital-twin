/** State of the replay page: which run is open, what is loaded and what the map shows. */
import { create } from "zustand";

import type { NetworkMsg, ReplayIndexMsg, ReplayIndexRunMsg, ResultsMsg } from "../simulation/state";
import { fetchResults } from "../simulation/websocket";
import { clock } from "./clock";
import type { RunInfo } from "./compare";
import { buildGeometry, type MapGeometry } from "./mapGeometry";
import { makePlayback, type Playback } from "./playback";
import { fetchReplayIndex, fetchReplayNetwork, fetchReplayRun } from "./replayApi";
import { baselineFor, defaultRun, parseDeepLink } from "./runs";

export type Follow = "off" | "ambulance" | "ghost" | "both";
export type Heat = "off" | "halting" | "vehicles" | "speed";
export type Layout = "overlay" | "split";
/** "baseline": the OFF run of the same seed (the ghost); "none"; or the id of any other run. */
export type CompareWith = "baseline" | "none" | (string & {});

export type RunLoad =
  | { status: "loading" }
  | { status: "ready"; playback: Playback }
  | { status: "missing" } // no telemetry was recorded for this run
  | { status: "error"; message: string };

const CACHE_LIMIT = 8; // playbacks kept in memory

export interface ReplayStore {
  index: ReplayIndexMsg | null;
  indexError: string | null;
  results: ResultsMsg | null;
  geometries: Record<string, MapGeometry | "loading" | "error">;
  loads: Record<string, RunLoad>;
  loadOrder: string[];

  selectedId: string | null;
  compareWith: CompareWith;

  showGhost: boolean;
  follow: Follow;
  onlyPreempted: boolean;
  showTraffic: boolean;
  heat: Heat;
  showLabels: boolean;
  showRoutes: boolean;
  demo: boolean;
  layout: Layout;
  selectedSignal: string | null;
  selectedEdge: string | null;
  viewNonce: number; // bumped to ask the map to reset or recentre its view
  viewRequest: ViewRequest | null;

  init: () => Promise<void>;
  select: (id: string) => void;
  setCompareWith: (value: CompareWith) => void;
  ensureRun: (id: string) => void;
  ensureGeometry: (scenario: string) => void;
  set: (patch: Partial<ReplayStore>) => void;
  requestView: (request: ViewRequest) => void;
}

export type ViewRequest =
  | { kind: "fit" }
  | { kind: "zoom"; factor: number }
  | { kind: "route" }
  | { kind: "ambulance" }
  | { kind: "ghost" }
  | { kind: "destination" }
  | { kind: "junction"; id: string }
  | { kind: "edge"; id: string };

export const useReplay = create<ReplayStore>((set, get) => ({
  index: null,
  indexError: null,
  results: null,
  geometries: {},
  loads: {},
  loadOrder: [],
  selectedId: null,
  compareWith: "baseline",
  showGhost: true,
  follow: "off",
  onlyPreempted: false,
  showTraffic: true,
  heat: "off",
  showLabels: true,
  showRoutes: true,
  demo: false,
  layout: "overlay",
  selectedSignal: null,
  selectedEdge: null,
  viewNonce: 0,
  viewRequest: null,

  init: async () => {
    try {
      const index = await fetchReplayIndex();
      set({ index, indexError: index.available ? null : index.note });
      fetchResults()
        .then((results) => set({ results }))
        .catch(() => undefined); // the batch summary is optional here
      const link = parseDeepLink(window.location.search);
      const linked = index.runs.find((r) => r.id === link.run);
      const first = linked ?? defaultRun(index.runs);
      if (first && get().selectedId === null) {
        get().select(first.id);
        if (link.ref && index.runs.some((r) => r.id === link.ref)) get().setCompareWith(link.ref);
        if (link.t !== null) {
          const at = link.t;
          setTimeout(() => clock.seek(at), 400); // once the run has set the clock's length
        }
      }
    } catch (error) {
      set({ indexError: error instanceof Error ? error.message : String(error) });
    }
  },

  select: (id) => {
    set({ selectedId: id, selectedSignal: null, selectedEdge: null, compareWith: "baseline" });
    clock.pause();
    clock.seek(0);
    get().ensureRun(id);
    const run = get().index?.runs.find((r) => r.id === id);
    if (run) {
      get().ensureGeometry(run.scenario);
      const baseline = baselineFor(get().index?.runs ?? [], run);
      if (baseline) get().ensureRun(baseline.id);
    }
    set((s) => ({ viewNonce: s.viewNonce + 1, viewRequest: { kind: "fit" } }));
  },

  setCompareWith: (value) => {
    set({ compareWith: value });
    if (value !== "baseline" && value !== "none") get().ensureRun(value);
  },

  ensureRun: (id) => {
    const state = get();
    const known = state.loads[id];
    const entry = state.index?.runs.find((r) => r.id === id);
    if (known || (entry && !entry.telemetry)) {
      if (!known && entry) set({ loads: { ...state.loads, [id]: { status: "missing" } } });
      return;
    }
    set({ loads: { ...state.loads, [id]: { status: "loading" } } });
    fetchReplayRun(id)
      .then((run) => {
        const loads = { ...get().loads };
        const order = [...get().loadOrder.filter((x) => x !== id), id];
        loads[id] = run === null ? { status: "missing" } : { status: "ready", playback: makePlayback(run) };
        while (order.length > CACHE_LIMIT) {
          const evicted = order.shift();
          if (evicted !== undefined && evicted !== get().selectedId) delete loads[evicted];
        }
        set({ loads, loadOrder: order });
      })
      .catch((error: unknown) => {
        set({ loads: { ...get().loads, [id]: { status: "error", message: error instanceof Error ? error.message : String(error) } } });
      });
  },

  ensureGeometry: (scenario) => {
    if (get().geometries[scenario]) return;
    set({ geometries: { ...get().geometries, [scenario]: "loading" } });
    fetchReplayNetwork(scenario)
      .then((network: NetworkMsg) => set({ geometries: { ...get().geometries, [scenario]: buildGeometry(network) } }))
      .catch(() => set({ geometries: { ...get().geometries, [scenario]: "error" } }));
  },

  set: (patch) => set(patch),
  requestView: (request) => set((s) => ({ viewNonce: s.viewNonce + 1, viewRequest: request })),
}));

// ---- derived -------------------------------------------------------------------------------
export function indexRun(index: ReplayIndexMsg | null, id: string | null): ReplayIndexRunMsg | null {
  return (id !== null && index?.runs.find((r) => r.id === id)) || null;
}

/** The id of the run compared against, or null (none chosen, or the run is the baseline itself). */
export function referenceId(index: ReplayIndexMsg | null, selectedId: string | null, compareWith: CompareWith): string | null {
  const run = indexRun(index, selectedId);
  if (run === null || compareWith === "none") return null;
  const id = compareWith === "baseline" ? (baselineFor(index?.runs ?? [], run)?.id ?? null) : compareWith;
  return id === run.id ? null : id;
}

export function runInfo(index: ReplayIndexMsg | null, loads: Record<string, RunLoad>, id: string | null): RunInfo | null {
  const run = indexRun(index, id);
  if (run === null) return null;
  const load = loads[run.id];
  return {
    id: run.id,
    scenario: run.scenario,
    scale: run.scale,
    seed: run.seed,
    arm: run.arm,
    summary: run.summary,
    playback: load?.status === "ready" ? load.playback : null,
  };
}

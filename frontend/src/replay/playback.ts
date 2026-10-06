/**
 * Playback of one recorded run (Sprint 11). Everything here reads the telemetry the backend
 * recorded from the simulation (experiments/telemetry): nothing is estimated or invented.
 *
 * Between two recorded samples a position is interpolated linearly (the angle along the shorter
 * arc). Before the first and after the last sample the first/last recorded pose is held: there is
 * no extrapolation. A value the simulation did not report stays null and the UI says
 * "Not recorded".
 */
import { lerp, lerpAngleDeg } from "../simulation/coords";
import type { ReplayEventMsg, ReplayRouteMsg, ReplayRunMsg, SignalControl } from "../simulation/state";

/** Events that get a marker on the timeline and are visited by previous/next event. */
export const MAJOR_KINDS: ReadonlySet<string> = new Set([
  "dispatch",
  "preempt",
  "reroute",
  "accident",
  "collision",
  "violation",
  "arrival",
]);

export type Held = "before" | "during" | "after";

export interface Pose {
  x: number;
  y: number;
  angle: number;
  speed: number;
  edge: string;
  lane: number;
  held: Held;
}

export interface SignalSeries {
  times: number[];
  states: string[];
  controls: SignalControl[];
}

export interface PreemptionSegment {
  junction: string;
  start: number;
  end: number;
  reachedGreen: boolean; // the controller held the approach green (stage "preempted")
}

export interface TrafficSamples {
  times: number[];
  /** per sample: [id index, x, y, angle] quads */
  data: number[][];
  /** per sample: row (quad index) of every vehicle id, -1 when absent */
  rows: Int32Array[];
  types: string[];
}

export interface Playback {
  run: ReplayRunMsg;
  duration: number;
  times: number[];
  signals: SignalSeries[];
  signalIndex: Map<string, number>;
  statusTimes: number[];
  edgeTimes: number[];
  routeTimes: number[];
  events: ReplayEventMsg[];
  eventTimes: number[];
  majorEvents: ReplayEventMsg[];
  distance: number[]; // metres driven by t = times[i], summed from the recorded positions
  preemptions: PreemptionSegment[];
  traffic: TrafficSamples | null;
}

/** Index of the last element <= t, or -1. `times` is ascending. */
export function lastAtOrBefore(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function signalSeries(run: ReplayRunMsg): SignalSeries[] {
  const { ids, initial, initialControl, changes } = run.signals;
  const series: SignalSeries[] = ids.map((_, i) => ({
    times: [0],
    states: [initial[i]],
    controls: [initialControl[i]],
  }));
  for (const [t, index, state, control] of changes) {
    const s = series[index];
    if (s === undefined) continue;
    s.times.push(t);
    s.states.push(state);
    s.controls.push(control);
  }
  return series;
}

function preemptionSegments(run: ReplayRunMsg, series: SignalSeries[]): PreemptionSegment[] {
  const out: PreemptionSegment[] = [];
  series.forEach((s, i) => {
    let open: PreemptionSegment | null = null;
    s.times.forEach((t, k) => {
      const control = s.controls[k];
      if (control !== "program") {
        open ??= { junction: run.signals.ids[i], start: t, end: run.durationS, reachedGreen: false };
        if (control === "preempted") open.reachedGreen = true;
      } else if (open !== null) {
        open.end = t;
        out.push(open);
        open = null;
      }
    });
    if (open !== null) out.push(open);
  });
  return out.sort((a, b) => a.start - b.start);
}

function trafficSamples(run: ReplayRunMsg): TrafficSamples | null {
  const traffic = run.traffic;
  if (traffic === null) return null;
  const rows = traffic.samples.map(([, flat]) => {
    const row = new Int32Array(traffic.ids.length).fill(-1);
    for (let k = 0; k * 4 < flat.length; k++) row[flat[k * 4]] = k;
    return row;
  });
  return { times: traffic.samples.map((s) => s[0]), data: traffic.samples.map((s) => s[1]), rows, types: traffic.types };
}

export function makePlayback(run: ReplayRunMsg): Playback {
  const times = run.ambulance.map((s) => s[0]);
  const distance: number[] = [];
  let driven = 0;
  run.ambulance.forEach((s, i) => {
    if (i > 0) driven += Math.hypot(s[1] - run.ambulance[i - 1][1], s[2] - run.ambulance[i - 1][2]);
    distance.push(driven);
  });
  const events = [...run.events].sort((a, b) => a.t - b.t);
  const signals = signalSeries(run);
  return {
    run,
    duration: Math.max(run.durationS, times.length > 0 ? times[times.length - 1] : 0),
    times,
    signals,
    signalIndex: new Map(run.signals.ids.map((id, i) => [id, i])),
    statusTimes: run.status.map((s) => s[0]),
    edgeTimes: run.edges.samples.map((s) => s.t),
    routeTimes: run.routes.map((r) => r.t),
    events,
    eventTimes: events.map((e) => e.t),
    majorEvents: events.filter((e) => MAJOR_KINDS.has(e.kind)),
    distance,
    preemptions: preemptionSegments(run, signals),
    traffic: trafficSamples(run),
  };
}

// ---- the ambulance ------------------------------------------------------------------------
export function poseAt(pb: Playback, t: number): Pose | null {
  const track = pb.run.ambulance;
  const n = track.length;
  if (n === 0) return null;
  const edges = pb.run.ambulanceEdges;
  const make = (a: (typeof track)[number], held: Held): Pose => ({
    x: a[1],
    y: a[2],
    angle: a[3],
    speed: a[4],
    edge: edges[a[5]],
    lane: a[6],
    held,
  });
  if (t <= pb.times[0]) return make(track[0], "before");
  if (t >= pb.times[n - 1]) return make(track[n - 1], "after");
  const i = lastAtOrBefore(pb.times, t);
  const a = track[i];
  const b = track[i + 1];
  const u = (t - a[0]) / (b[0] - a[0]);
  const near = u < 0.5 ? a : b; // the road and lane the ambulance is on: the nearer sample's
  return {
    x: lerp(a[1], b[1], u),
    y: lerp(a[2], b[2], u),
    angle: lerpAngleDeg(a[3], b[3], u),
    speed: lerp(a[4], b[4], u),
    edge: edges[near[5]],
    lane: near[6],
    held: "during",
  };
}

export interface StatusAt {
  eta: number | null;
  distanceLeft: number | null;
  nextJunction: string | null;
  nextState: string | null;
  driven: number;
}

/** The last status the simulation reported at or before t (1 Hz), and the distance driven. */
export function statusAt(pb: Playback, t: number): StatusAt {
  const k = lastAtOrBefore(pb.statusTimes, t);
  const s = k >= 0 ? pb.run.status[k] : null;
  return {
    eta: s?.[1] ?? null,
    distanceLeft: s?.[2] ?? null,
    nextJunction: s?.[3] ?? null,
    nextState: s?.[4] ?? null,
    driven: drivenAt(pb, t),
  };
}

/** Metres driven by t: the recorded path length, interpolated between two samples. */
export function drivenAt(pb: Playback, t: number): number {
  const i = lastAtOrBefore(pb.times, t);
  if (i < 0) return 0;
  if (i + 1 >= pb.times.length) return pb.distance[i];
  const u = (t - pb.times[i]) / (pb.times[i + 1] - pb.times[i]);
  return lerp(pb.distance[i], pb.distance[i + 1], u);
}

export interface RouteAt {
  current: ReplayRouteMsg | null;
  previous: ReplayRouteMsg | null; // the route replaced by `current`; null before any change
  changedAt: number | null;
}

export function routeAt(pb: Playback, t: number): RouteAt {
  const i = lastAtOrBefore(pb.routeTimes, t);
  if (i < 0) return { current: null, previous: null, changedAt: null };
  const routes = pb.run.routes;
  return { current: routes[i], previous: i > 0 ? routes[i - 1] : null, changedAt: i > 0 ? routes[i].t : null };
}

// ---- signals ------------------------------------------------------------------------------
export interface SignalAt {
  state: string;
  control: SignalControl;
}

export function signalAt(pb: Playback, junction: string, t: number): SignalAt | null {
  const i = pb.signalIndex.get(junction);
  if (i === undefined) return null;
  const s = pb.signals[i];
  const k = Math.max(0, lastAtOrBefore(s.times, t));
  return { state: s.states[k], control: s.controls[k] };
}

/** "Normal", "Clearing", "All-red", "Preempted" or "Recovery", from what was recorded. */
export function stageLabel(control: SignalControl, state: string): string {
  switch (control) {
    case "program":
      return "Normal";
    case "clearing":
      return /[GgyYuU]/.test(state) ? "Clearing" : "All-red";
    case "preempted":
      return "Preempted";
    case "recovering":
      return "Recovery";
  }
}

export type Lamp = "green" | "yellow" | "red";

/** The colour a set of links shows: green wins over yellow over red. */
export function lampOf(state: string, links: readonly number[]): Lamp {
  let lamp: Lamp = "red";
  for (const index of links) {
    const c = state[index];
    if (c === "G" || c === "g") return "green";
    if (c === "y" || c === "Y") lamp = "yellow";
  }
  return lamp;
}

/** The segment of controller-driven (not normal-program) signal control containing t, if any. */
export function preemptionAt(pb: Playback, junction: string, t: number): PreemptionSegment | null {
  return pb.preemptions.find((p) => p.junction === junction && t >= p.start && t < p.end) ?? null;
}

// ---- events -------------------------------------------------------------------------------
export function eventsUpTo(pb: Playback, t: number): ReplayEventMsg[] {
  return pb.events.slice(0, lastAtOrBefore(pb.eventTimes, t) + 1);
}

export function nextEvent(pb: Playback, t: number): ReplayEventMsg | null {
  return pb.majorEvents.find((e) => e.t > t + 0.05) ?? null;
}

export function previousEvent(pb: Playback, t: number): ReplayEventMsg | null {
  for (let i = pb.majorEvents.length - 1; i >= 0; i--) if (pb.majorEvents[i].t < t - 0.05) return pb.majorEvents[i];
  return null;
}

// ---- roads --------------------------------------------------------------------------------
/** Per-road counts of the last 5 s sample at or before t (piecewise constant, as recorded). */
export function edgeSampleIndex(pb: Playback, t: number): number {
  return Math.max(0, lastAtOrBefore(pb.edgeTimes, t));
}

export function totalHalting(pb: Playback, sample: number): number {
  const s = pb.run.edges.samples[sample];
  return s === undefined ? 0 : s.halting.reduce((a, b) => a + b, 0);
}

// ---- background traffic -------------------------------------------------------------------
export interface TrafficFrame {
  count: number;
  x: Float32Array;
  y: Float32Array;
  angle: Float32Array;
  type: Uint16Array;
}

export function newTrafficFrame(capacity: number): TrafficFrame {
  return {
    count: 0,
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    angle: new Float32Array(capacity),
    type: new Uint16Array(capacity),
  };
}

/**
 * Vehicles at time t: only those recorded in BOTH samples around t are drawn, interpolated
 * between them. A vehicle recorded in one sample only (entering or leaving the map) is skipped
 * rather than extrapolated.
 */
export function trafficAt(pb: Playback, t: number, out: TrafficFrame, typeIndex: (type: string) => number): number {
  const tr = pb.traffic;
  out.count = 0;
  if (tr === null) return 0;
  const i = lastAtOrBefore(tr.times, t);
  if (i < 0 || i + 1 >= tr.times.length) return 0;
  const u = (t - tr.times[i]) / (tr.times[i + 1] - tr.times[i]);
  const a = tr.data[i];
  const b = tr.data[i + 1];
  const rowsB = tr.rows[i + 1];
  for (let k = 0; k * 4 < a.length && out.count < out.x.length; k++) {
    const id = a[k * 4];
    const row = rowsB[id];
    if (row < 0) continue;
    const n = out.count++;
    out.x[n] = lerp(a[k * 4 + 1], b[row * 4 + 1], u);
    out.y[n] = lerp(a[k * 4 + 2], b[row * 4 + 2], u);
    out.angle[n] = lerpAngleDeg(a[k * 4 + 3], b[row * 4 + 3], u);
    out.type[n] = typeIndex(tr.types[id]);
  }
  return out.count;
}


// ---- derived state, kept pure so it can be tested ------------------------------------------
export type MissionState = "driving" | "arrived";

/** "arrived" once the recorded arrival event has happened, else "driving". */
export function missionState(pb: Playback, t: number): MissionState {
  const i = lastAtOrBefore(pb.eventTimes, t);
  for (let k = i; k >= 0; k--) if (pb.events[k].kind === "arrival") return "arrived";
  return "driving";
}

/** The "only preempted signals" filter: a junction shows when the safety controller (not the
 * normal program) has it, or when the filter is off. */
export function signalVisible(sig: SignalAt | null, onlyPreempted: boolean): boolean {
  return !onlyPreempted || (sig !== null && sig.control !== "program");
}

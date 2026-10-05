/**
 * Protocol v1 types (CLAUDE.md section 9) and the Zustand store.
 * Mirrors backend/api/protocol.py: change both in the same commit.
 */
import { create } from "zustand";

export const PROTOCOL_VERSION = 1;
export const AMBULANCE_ID = "ambulance_01";
export const TICK_MS = 100; // backend steps and broadcasts at 10 Hz

export type Direction = "left" | "right";
export type Point = [number, number];
export type SignalMode = "OFF" | "BASIC" | "COORD";
export type MissionStatus = "none" | "pending" | "driving" | "arrived";
export type TurnKind = "left" | "straight" | "right" | "uturn";

// ---- backend -> frontend ---------------------------------------------------------
export interface VehicleMsg {
  id: string;
  type: string; // vType id = asset key
  x: number; // m, vehicle centre, SUMO coordinates
  y: number;
  angle: number; // deg clockwise from north
  speed: number; // m/s
  edge: string;
  lane: number; // 0 = curb lane
}

export type SignalControl = "program" | "clearing" | "preempted" | "recovering";

export interface SignalMsg {
  id: string;
  state: string; // one SUMO char per link: G g y r ...
  phase: number; // normal program phase (meaningless while not under program control)
  preempted: boolean; // the safety controller, not the normal program, drives it
  control: SignalControl;
}

export interface NextSignalMsg {
  junction: string;
  linkIndex: number;
  distance: number;
  state: string;
}

export interface PlannedTurnMsg {
  junction: string;
  turn: TurnKind;
  edge: string;
}

export interface AmbulanceMsg {
  id: string;
  status: MissionStatus;
  throttle: number;
  brake: number;
  nextSignal: NextSignalMsg | null;
  plannedTurn: PlannedTurnMsg | null;
  queuedTurn: Direction | null;
  missionTime: number | null;
}

export interface MetricsMsg {
  eta: number | null;
  signalsPreempted: number;
  queueCleared: number | null;
  timeSaved: number | null; // only ever measured (ghost run)
}

export interface SafetyEventMsg {
  t: number;
  junction: string;
  vehicle: string | null;
  action: string; // preempt, green, release, timeout, resume, fail_safe
  accepted: boolean;
  reason: string;
}

export interface SafetyMsg {
  violations: number; // independent monitor; must stay 0
  collisions: number; // SUMO-detected
  events: SafetyEventMsg[]; // safety controller decisions, most recent last
}

export interface StateMsg {
  v: 1;
  type: "state";
  seq: number;
  t: number;
  mode: SignalMode;
  vehicles: VehicleMsg[];
  signals: SignalMsg[];
  ambulance: AmbulanceMsg;
  route: null; // Sprint 6
  metrics: MetricsMsg;
  safety: SafetyMsg;
  incidents: string[]; // Sprint 8
}

export interface AckMsg {
  v: 1;
  type: "ack";
  id: number;
  ok: boolean;
  reason: string;
}

export interface ErrorMsg {
  v: 1;
  type: "error";
  reason: string;
}

/** Driver lock: one screen drives, the others observe. "free": nobody drives yet. */
export type SessionRole = "driver" | "observer" | "free";

export interface SessionMsg {
  v: 1;
  type: "session";
  clientId: string;
  role: SessionRole;
}

export type ServerMsg = StateMsg | AckMsg | ErrorMsg | SessionMsg;

// ---- GET /api/health -------------------------------------------------------------
export interface HealthMsg {
  status: "starting" | "running" | "error";
  error: string | null;
  seq: number | null;
  t: number | null;
  vehicles: number;
  tickMsP50: number | null;
  tickMsP95: number | null;
  tickMsMax: number | null;
  sumoStepMsP50: number | null;
}

// ---- GET /api/network ------------------------------------------------------------
export interface LaneMsg {
  id: string;
  edge: string;
  index: number;
  width: number;
  shape: Point[];
}

export interface JunctionMsg {
  id: string;
  type: string;
  shape: Point[];
}

export interface LinkMsg {
  index: number;
  fromLane: string;
  toLane: string;
  dir: string;
  approach: string;
}

export interface SignalLinksMsg {
  id: string;
  links: LinkMsg[];
}

export interface PlaceMsg {
  edge: string;
  pos: number;
  x: number;
  y: number;
}

export interface NetworkMsg {
  v: 1;
  lefthand: boolean;
  bounds: [number, number, number, number]; // xmin, ymin, xmax, ymax
  lanes: LaneMsg[];
  junctions: JunctionMsg[];
  signals: SignalLinksMsg[];
  depot: PlaceMsg;
  hospital: PlaceMsg;
}

// ---- frontend -> backend ---------------------------------------------------------
export type Command =
  | { v: 1; id: number; cmd: "spawn_ambulance" }
  | { v: 1; cmd: "drive"; vehicle: string; control: { throttle: number; brake: number } }
  | { v: 1; id: number; cmd: "turn"; vehicle: string; direction: Direction }
  | { v: 1; id: number; cmd: "lane"; vehicle: string; direction: Direction }
  | { v: 1; id: number; cmd: "set_mode"; mode: SignalMode }
  | { v: 1; id: number; cmd: "reset" }
  | { v: 1; cmd: "hello"; clientId: string }
  | { v: 1; id: number; cmd: "release_control" };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A command before the socket stamps the protocol version and id. */
export type CommandBody = DistributiveOmit<Command, "v" | "id">;

// ---- store -----------------------------------------------------------------------
export interface Frame {
  msg: StateMsg;
  receivedAt: number; // performance.now() ms
}

export type ConnectionStatus = "connecting" | "open" | "closed";

/** Camera: behind the ambulance (overview while none is out), free orbit, or 2D map. */
export type ViewMode = "chase" | "orbit" | "top";
export const VIEW_MODES: ViewMode[] = ["chase", "orbit", "top"];

export interface DriveKeys {
  throttle: boolean;
  brake: boolean;
}

const LATENCY_SAMPLES = 20;
const LATENCY_GIVE_UP_MS = 2000; // e.g. W pressed while waiting at a red light
// A previous tick older than this (reconnect, hidden tab) is not interpolated from:
// vehicles jump to their current position instead of sliding across the gap.
const STALE_FRAME_MS = 500;

export interface SimStore {
  connection: ConnectionStatus;
  network: NetworkMsg | null;
  prev: Frame | null; // the two latest ticks, for interpolation
  curr: Frame | null;
  lastReply: AckMsg | ErrorMsg | null;
  role: SessionRole; // driver lock, from the server's session messages
  keys: DriveKeys; // local key state, shown instantly in the HUD
  pendingInput: { at: number; speed: number } | null;
  latencyMs: number[]; // W press -> first tick in which the ambulance speeds up
  follow: boolean; // top view: keep the ambulance centred
  view: ViewMode;
  fps: number;
  drawCalls: number;
  triangles: number;
  setConnection: (connection: ConnectionStatus) => void;
  setNetwork: (network: NetworkMsg) => void;
  receiveState: (msg: StateMsg, now: number) => void;
  receiveReply: (msg: AckMsg | ErrorMsg) => void;
  receiveSession: (msg: SessionMsg) => void;
  setKeys: (keys: DriveKeys, now: number) => void;
  toggleFollow: () => void;
  setView: (view: ViewMode) => void;
  cycleView: () => void;
  setRenderStats: (fps: number, drawCalls: number, triangles?: number) => void;
}

export function ambulanceOf(msg: StateMsg | undefined): VehicleMsg | undefined {
  return msg?.vehicles.find((v) => v.id === AMBULANCE_ID);
}

export const useSim = create<SimStore>()((set, get) => ({
  connection: "connecting",
  network: null,
  prev: null,
  curr: null,
  lastReply: null,
  role: "free",
  keys: { throttle: false, brake: false },
  pendingInput: null,
  latencyMs: [],
  follow: true,
  view: "chase",
  fps: 0,
  drawCalls: 0,
  triangles: 0,

  setConnection: (connection) => set({ connection }),
  setNetwork: (network) => set({ network }),

  receiveState: (msg, now) => {
    const { curr, pendingInput, latencyMs } = get();
    // A simulation reset makes time jump back, and a reconnect leaves a gap: in both
    // cases start interpolation afresh rather than sliding from a stale position.
    const fresh = curr !== null && now - curr.receivedAt <= STALE_FRAME_MS;
    const prev = curr && fresh && msg.t >= curr.msg.t ? curr : null;
    let pending = pendingInput;
    let samples = latencyMs;
    if (pending) {
      const speed = ambulanceOf(msg)?.speed ?? 0;
      if (speed > pending.speed + 0.05) {
        samples = [...latencyMs, now - pending.at].slice(-LATENCY_SAMPLES);
        pending = null;
      } else if (now - pending.at > LATENCY_GIVE_UP_MS) {
        pending = null;
      }
    }
    set({ prev, curr: { msg, receivedAt: now }, pendingInput: pending, latencyMs: samples });
  },

  receiveReply: (msg) => set({ lastReply: msg }),
  receiveSession: (msg) => set({ role: msg.role }),

  setKeys: (keys, now) => {
    const { keys: old, curr } = get();
    if (old.throttle === keys.throttle && old.brake === keys.brake) return;
    const pressedThrottle = keys.throttle && !old.throttle && !keys.brake;
    const speed = ambulanceOf(curr?.msg)?.speed ?? 0;
    set({
      keys,
      pendingInput: pressedThrottle ? { at: now, speed } : get().pendingInput,
    });
  },

  toggleFollow: () => set({ follow: !get().follow }),
  setView: (view) => set({ view }),
  cycleView: () => {
    const i = VIEW_MODES.indexOf(get().view);
    set({ view: VIEW_MODES[(i + 1) % VIEW_MODES.length]! });
  },
  setRenderStats: (fps, drawCalls, triangles = 0) => set({ fps, drawCalls, triangles }),
}));

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

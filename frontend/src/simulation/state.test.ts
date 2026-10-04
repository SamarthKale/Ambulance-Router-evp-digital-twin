import { beforeEach, describe, expect, it } from "vitest";

import { AMBULANCE_ID, median, useSim, type StateMsg } from "./state";

function tick(seq: number, t: number, speed: number): StateMsg {
  return {
    v: 1,
    type: "state",
    seq,
    t,
    mode: "OFF",
    vehicles: [
      { id: AMBULANCE_ID, type: "ambulance", x: 10, y: 200, angle: 90, speed, edge: "w0_A0", lane: 0 },
    ],
    signals: [],
    ambulance: {
      id: AMBULANCE_ID,
      status: "driving",
      throttle: 0,
      brake: 0,
      nextSignal: null,
      plannedTurn: null,
      queuedTurn: null,
      missionTime: t,
    },
    route: null,
    metrics: { eta: null, signalsPreempted: 0, queueCleared: null, timeSaved: null },
    safety: { violations: 0, collisions: 0, events: [] },
    incidents: [],
  };
}

const initial = useSim.getState();
beforeEach(() => useSim.setState(initial, true));

describe("receiveState", () => {
  it("keeps the two latest ticks for interpolation", () => {
    const store = useSim.getState();
    store.receiveState(tick(1, 1.0, 0), 1000);
    store.receiveState(tick(2, 1.1, 0), 1100);
    const { prev, curr } = useSim.getState();
    expect(prev?.msg.seq).toBe(1);
    expect(curr?.msg.seq).toBe(2);
    expect(curr?.receivedAt).toBe(1100);
  });

  it("drops the previous tick when the simulation was reset (time went back)", () => {
    const store = useSim.getState();
    store.receiveState(tick(1, 50.0, 0), 1000);
    store.receiveState(tick(2, 0.1, 0), 1100);
    expect(useSim.getState().prev).toBeNull();
  });
});

describe("input latency", () => {
  it("measures from W press to the first tick where the ambulance speeds up", () => {
    const store = useSim.getState();
    store.receiveState(tick(1, 1.0, 5), 1000);
    store.setKeys({ throttle: true, brake: false }, 1010);
    store.receiveState(tick(2, 1.1, 5), 1100); // not yet applied
    store.receiveState(tick(3, 1.2, 5.35), 1180);
    expect(useSim.getState().latencyMs).toEqual([170]);
    expect(useSim.getState().pendingInput).toBeNull();
  });

  it("gives up when the ambulance cannot accelerate (e.g. waiting at a red light)", () => {
    const store = useSim.getState();
    store.receiveState(tick(1, 1.0, 0), 1000);
    store.setKeys({ throttle: true, brake: false }, 1000);
    store.receiveState(tick(2, 3.5, 0), 3500);
    expect(useSim.getState().latencyMs).toEqual([]);
    expect(useSim.getState().pendingInput).toBeNull();
  });

  it("ignores repeated identical key states (heartbeat)", () => {
    const store = useSim.getState();
    store.setKeys({ throttle: true, brake: false }, 1000);
    store.setKeys({ throttle: true, brake: false }, 1100);
    expect(useSim.getState().pendingInput?.at).toBe(1000);
  });
});

describe("median", () => {
  it("handles empty, odd and even inputs", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

import { describe, expect, it } from "vitest";

import {
  edgeSampleIndex,
  eventsUpTo,
  lampOf,
  lastAtOrBefore,
  makePlayback,
  missionState,
  signalVisible,
  newTrafficFrame,
  nextEvent,
  poseAt,
  preemptionAt,
  previousEvent,
  routeAt,
  signalAt,
  stageLabel,
  statusAt,
  totalHalting,
  trafficAt,
} from "./playback";
import { fakeRun, hasRealData, loadRealNetwork, loadRealRun } from "./testData";
import { buildGeometry, nearestEdge } from "./mapGeometry";

const pb = makePlayback(fakeRun());

describe("lastAtOrBefore", () => {
  it("finds the last element at or before t", () => {
    const times = [0, 5, 10];
    expect(lastAtOrBefore(times, -1)).toBe(-1);
    expect(lastAtOrBefore(times, 0)).toBe(0);
    expect(lastAtOrBefore(times, 4.99)).toBe(0);
    expect(lastAtOrBefore(times, 5)).toBe(1);
    expect(lastAtOrBefore(times, 99)).toBe(2);
    expect(lastAtOrBefore([], 1)).toBe(-1);
  });
});

describe("the ambulance pose", () => {
  it("is exactly the recorded sample at a recorded time", () => {
    const pose = poseAt(pb, 5);
    expect(pose).toMatchObject({ x: 100, y: 200, angle: 90, speed: 20, edge: "w0_A0", lane: 0 });
  });

  it("interpolates linearly between two recorded samples, the angle along the shorter arc", () => {
    const pose = poseAt(pb, 7.5);
    expect(pose?.held).toBe("during");
    expect(pose?.x).toBeCloseTo(150); // halfway between 100 and 200
    expect(pose?.y).toBeCloseTo(205);
    expect(pose?.speed).toBeCloseTo(15);
    expect(pose?.angle).toBeCloseTo(45); // 90 -> 0
  });

  it("takes the road and lane of the nearer sample", () => {
    expect(poseAt(pb, 7)?.edge).toBe("w0_A0");
    expect(poseAt(pb, 8)?.edge).toBe("A0_B0");
    expect(poseAt(pb, 8)?.lane).toBe(1);
  });

  it("never extrapolates: it holds the first and the last recorded pose", () => {
    expect(poseAt(pb, -3)).toMatchObject({ x: 0, held: "before" });
    expect(poseAt(pb, 500)).toMatchObject({ x: 200, y: 210, speed: 0, held: "after" });
  });

  it("is null for a run without a track", () => {
    expect(poseAt(makePlayback(fakeRun({ ambulance: [] })), 1)).toBeNull();
  });

  it("sums the distance driven from the recorded positions", () => {
    expect(pb.distance[0]).toBe(0);
    expect(pb.distance[1]).toBeCloseTo(100);
    expect(pb.distance[2]).toBeCloseTo(100 + Math.hypot(100, 10));
    expect(statusAt(pb, 7.5).driven).toBeCloseTo(100 + Math.hypot(100, 10) / 2); // interpolated
    expect(statusAt(pb, 99).driven).toBeCloseTo(pb.distance[3]); // held after the last sample
    expect(statusAt(pb, -1).driven).toBe(0);
  });
});

describe("status and route", () => {
  it("is the last report at or before t, and null where nothing was reported", () => {
    expect(statusAt(pb, 6)).toMatchObject({ eta: 5, distanceLeft: 100, nextJunction: "B0", nextState: "G" });
    expect(statusAt(pb, 10)).toMatchObject({ eta: null, distanceLeft: null, nextJunction: null });
  });

  it("keeps the replaced route so old and new can both be drawn", () => {
    expect(routeAt(pb, 1).current?.edges).toEqual(["w0_A0", "A0_B0"]);
    expect(routeAt(pb, 1).previous).toBeNull();
    const after = routeAt(pb, 6);
    expect(after.current?.edges).toEqual(["A0_B0", "B0_e0"]);
    expect(after.previous?.edges).toEqual(["w0_A0", "A0_B0"]);
    expect(after.changedAt).toBe(6);
  });
});

describe("signals", () => {
  it("shows the recorded state and controller stage at a time", () => {
    expect(signalAt(pb, "A0", 1)).toEqual({ state: "rrGG", control: "program" }); // initial
    expect(signalAt(pb, "A0", 3)).toEqual({ state: "yyGG", control: "clearing" });
    expect(signalAt(pb, "A0", 5.5)).toEqual({ state: "rrrr", control: "clearing" });
    expect(signalAt(pb, "A0", 6)).toEqual({ state: "GGrr", control: "preempted" });
    expect(signalAt(pb, "B0", 7)).toEqual({ state: "GGrr", control: "program" }); // never changed
    expect(signalAt(pb, "Z9", 1)).toBeNull();
  });

  it("names the stages from what was recorded (all-red is a clearing state with no lamp lit)", () => {
    expect(stageLabel("program", "GGrr")).toBe("Normal");
    expect(stageLabel("clearing", "yyGG")).toBe("Clearing");
    expect(stageLabel("clearing", "rrrr")).toBe("All-red");
    expect(stageLabel("preempted", "GGrr")).toBe("Preempted");
    expect(stageLabel("recovering", "rrGG")).toBe("Recovery");
  });

  it("colours an approach green over yellow over red", () => {
    expect(lampOf("GGrr", [0, 1])).toBe("green");
    expect(lampOf("ygrr", [0, 2])).toBe("yellow");
    expect(lampOf("GGrr", [2, 3])).toBe("red");
    expect(lampOf("rrrr", [])).toBe("red");
  });

  it("lists the controller's hold on a junction as one segment", () => {
    expect(pb.preemptions).toEqual([{ junction: "A0", start: 3, end: 9, reachedGreen: true }]);
    expect(preemptionAt(pb, "A0", 4)?.junction).toBe("A0");
    expect(preemptionAt(pb, "A0", 9.5)).toBeNull();
    expect(preemptionAt(pb, "B0", 4)).toBeNull();
  });
});

describe("events", () => {
  it("steps through the major events only (route reviews are in the log, not markers)", () => {
    expect(pb.majorEvents.map((e) => e.kind)).toEqual(["dispatch", "preempt", "reroute", "arrival"]);
    expect(nextEvent(pb, 0)?.kind).toBe("preempt");
    expect(nextEvent(pb, 3)?.kind).toBe("reroute");
    expect(nextEvent(pb, 10)).toBeNull();
    expect(previousEvent(pb, 6)?.kind).toBe("preempt");
    expect(previousEvent(pb, 6.5)?.kind).toBe("reroute");
    expect(previousEvent(pb, 0)).toBeNull();
  });

  it("lists the events up to a time", () => {
    expect(eventsUpTo(pb, 3.5).map((e) => e.kind)).toEqual(["dispatch", "preempt"]);
    expect(eventsUpTo(pb, -1)).toEqual([]);
    expect(eventsUpTo(pb, 99)).toHaveLength(5);
  });
});

describe("roads", () => {
  it("uses the last recorded sample (counts are recorded every 5 s)", () => {
    expect(edgeSampleIndex(pb, 4.9)).toBe(0);
    expect(edgeSampleIndex(pb, 5)).toBe(1);
    expect(totalHalting(pb, 0)).toBe(3);
    expect(totalHalting(pb, 1)).toBe(1);
  });
});

describe("background traffic", () => {
  const types = new Map<string, number>();
  const typeIndex = (t: string) => {
    if (!types.has(t)) types.set(t, types.size);
    return types.get(t) ?? 0;
  };

  it("interpolates a vehicle recorded in both samples and skips one recorded in only one", () => {
    const frame = newTrafficFrame(10);
    expect(trafficAt(pb, 0.5, frame, typeIndex)).toBe(1); // b leaves, c has not entered
    expect(frame.x[0]).toBeCloseTo(15);
    expect(trafficAt(pb, 1.5, frame, typeIndex)).toBe(2);
    expect([frame.x[0], frame.x[1]]).toEqual([25, 55]);
    expect(frame.y[1]).toBeCloseTo(210); // c: (50,210) -> (60,210)
  });

  it("draws nothing past the last sample or when the traffic was not recorded", () => {
    const frame = newTrafficFrame(10);
    expect(trafficAt(pb, 2, frame, typeIndex)).toBe(0);
    expect(trafficAt(makePlayback(fakeRun({ traffic: null })), 0.5, frame, typeIndex)).toBe(0);
  });
});

describe.skipIf(!hasRealData())("the real recorded runs", () => {
  const network = buildGeometry(loadRealNetwork());
  const run = loadRealRun("basic_static", "grid4x4_x1.5_seed001");
  const real = makePlayback(run);

  it("have an ambulance track that lies on the real road map", () => {
    expect(run.ambulance.length).toBeGreaterThan(100);
    for (const sample of run.ambulance) {
      expect(nearestEdge(network, sample[1], sample[2], 16), `t=${sample[0]}`).not.toBeNull();
    }
  });

  it("only name roads and junctions the map has", () => {
    for (const route of run.routes) for (const edge of route.edges) expect(network.edgeLine.has(edge)).toBe(true);
    for (const id of run.signals.ids) expect(network.signalIds).toContain(id);
    for (const edge of run.edges.ids) expect(network.edgeLine.has(edge)).toBe(true);
    for (const edge of run.ambulanceEdges) expect(edge.startsWith(":") || network.edgeLine.has(edge)).toBe(true);
  });

  it("have consistent times, signal changes and events", () => {
    expect(real.times).toEqual([...real.times].sort((a, b) => a - b));
    expect(run.events[0].kind).toBe("dispatch");
    for (const e of run.events) expect(e.t).toBeGreaterThanOrEqual(0);
    for (const [t, index] of run.signals.changes) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(run.signals.ids.length);
    }
    const arrival = run.events.find((e) => e.kind === "arrival");
    expect(arrival?.t).toBeCloseTo(run.missionTime ?? -1, 0);
    expect(real.preemptions.length).toBeGreaterThan(0); // BASIC preempts
    expect(real.preemptions.every((p) => p.reachedGreen)).toBe(true);
  });

  it("have background vehicles that are interpolated between recorded samples", () => {
    expect(run.traffic).not.toBeNull();
    const frame = newTrafficFrame(2000);
    const count = trafficAt(real, 20.5, frame, () => 0);
    expect(count).toBeGreaterThan(50);
    for (let i = 0; i < count; i++) expect(nearestEdge(network, frame.x[i], frame.y[i], 25)).not.toBeNull();
  });
});

describe("derived state", () => {
  it("is driving until the recorded arrival, then arrived", () => {
    expect(missionState(pb, 0)).toBe("driving");
    expect(missionState(pb, 9.9)).toBe("driving");
    expect(missionState(pb, 10)).toBe("arrived");
    expect(missionState(pb, 11.5)).toBe("arrived");
  });

  it("filters to the junctions the safety controller holds", () => {
    expect(signalVisible({ state: "GGrr", control: "preempted" }, true)).toBe(true);
    expect(signalVisible({ state: "yyGG", control: "clearing" }, true)).toBe(true);
    expect(signalVisible({ state: "rrGG", control: "recovering" }, true)).toBe(true);
    expect(signalVisible({ state: "rrGG", control: "program" }, true)).toBe(false);
    expect(signalVisible(null, true)).toBe(false);
    expect(signalVisible({ state: "rrGG", control: "program" }, false)).toBe(true);
    expect(signalVisible(null, false)).toBe(true);
  });
});

describe("a run with no recorded series (empty telemetry)", () => {
  const empty = makePlayback(
    fakeRun({
      ambulance: [],
      status: [],
      routes: [],
      events: [],
      durationS: 0,
      missionTime: null,
      arrived: false,
      traffic: null,
      edges: { ids: [], intervalS: 5, samples: [] },
      signals: { ids: [], initial: [], initialControl: [], changes: [] },
    }),
  );

  it("builds, and every reader says there is nothing instead of inventing something", () => {
    expect(empty.duration).toBe(0);
    expect(poseAt(empty, 3)).toBeNull();
    expect(statusAt(empty, 3)).toEqual({ eta: null, distanceLeft: null, nextJunction: null, nextState: null, driven: 0 });
    expect(routeAt(empty, 3)).toEqual({ current: null, previous: null, changedAt: null });
    expect(signalAt(empty, "A0", 3)).toBeNull();
    expect(eventsUpTo(empty, 3)).toEqual([]);
    expect(nextEvent(empty, 0)).toBeNull();
    expect(previousEvent(empty, 5)).toBeNull();
    expect(empty.preemptions).toEqual([]);
    expect(totalHalting(empty, 0)).toBe(0);
    expect(trafficAt(empty, 1, newTrafficFrame(4), () => 0)).toBe(0);
    expect(missionState(empty, 5)).toBe("driving");
  });
});

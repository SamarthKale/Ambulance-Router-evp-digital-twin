import { describe, expect, it } from "vitest";

import { searchAll } from "./search";
import { fakeRun } from "./testData";

const events = fakeRun().events;
const junctions = ["A0", "A1", "B0", "C2"];
const edges = ["A0_A1", "A0_B0", "w0_A0"];

describe("searchAll", () => {
  it("finds junctions, roads and events by text, junction ids first", () => {
    const results = searchAll("a0", junctions, edges, events);
    expect(results[0]).toMatchObject({ type: "junction", id: "A0" });
    expect(results.map((r) => r.type)).toContain("edge");
    expect(results.map((r) => r.type)).toContain("event"); // "clearing A0"
  });

  it("finds events by kind and gives their time to seek to", () => {
    const results = searchAll("reroute", junctions, edges, events);
    expect(results).toEqual([expect.objectContaining({ type: "event", t: 6 })]);
    expect(searchAll("arrival", junctions, edges, events)[0].t).toBe(10);
  });

  it("is case-insensitive, trims, and returns nothing for an empty or unmatched query", () => {
    expect(searchAll("  PREEMPT ", junctions, edges, events)[0]).toMatchObject({ type: "event", t: 3 });
    expect(searchAll("", junctions, edges, events)).toEqual([]);
    expect(searchAll("zzz", junctions, edges, events)).toEqual([]);
  });

  it("limits the number of results", () => {
    const many = Array.from({ length: 50 }, (_, i) => `J${i}`);
    expect(searchAll("j", many, [], [])).toHaveLength(12);
  });
});

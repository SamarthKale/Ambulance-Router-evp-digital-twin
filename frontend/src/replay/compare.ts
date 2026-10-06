/**
 * Actual vs reference (the OFF ghost): both are recorded runs of the same seed, so they started
 * from the same traffic and the same mission. Every number comes from runs.csv (the result) or
 * from the recorded track; "time saved" exists only when both runs arrived and are comparable.
 */
import type { Playback } from "./playback";
import type { ReplaySummaryMsg } from "../simulation/state";

export interface RunInfo {
  id: string;
  scenario: string;
  scale: number;
  seed: number;
  arm: string;
  summary: ReplaySummaryMsg | null;
  playback: Playback | null;
}

export interface CompareRow {
  key: string;
  label: string;
  unit: string;
  actual: number | null;
  reference: number | null;
  delta: number | null; // actual minus reference
  lowerIsBetter: boolean | null; // null: neither direction is "better" (a count of events)
  source: "runs.csv" | "recorded track";
}

export interface Comparison {
  comparable: boolean;
  reason: string; // why not comparable, or why there is no time saved
  rows: CompareRow[];
  timeSaved: number | null; // reference travel time minus actual, seconds
}

function row(
  key: string,
  label: string,
  unit: string,
  actual: number | null | undefined,
  reference: number | null | undefined,
  lowerIsBetter: boolean | null,
  source: CompareRow["source"],
): CompareRow {
  const a = actual ?? null;
  const r = reference ?? null;
  return { key, label, unit, actual: a, reference: r, delta: a !== null && r !== null ? a - r : null, lowerIsBetter, source };
}

export function sameTraffic(a: RunInfo, b: RunInfo): boolean {
  return a.scenario === b.scenario && a.scale === b.scale && a.seed === b.seed;
}

export function drivenMetres(info: RunInfo): number | null {
  const pb = info.playback;
  return pb === null || pb.distance.length === 0 ? null : pb.distance[pb.distance.length - 1];
}

export function compareRuns(actual: RunInfo, reference: RunInfo | null): Comparison {
  if (reference === null) return { comparable: false, reason: "No comparison run selected.", rows: [], timeSaved: null };
  if (actual.id === reference.id) return { comparable: false, reason: "The same run on both sides.", rows: [], timeSaved: null };
  if (!sameTraffic(actual, reference)) {
    return { comparable: false, reason: "The runs are not on the same scenario, demand and seed.", rows: [], timeSaved: null };
  }
  const a = actual.summary;
  const r = reference.summary;
  const rows = [
    row("travel", "Travel time", "s", a?.travelS, r?.travelS, true, "runs.csv"),
    row("wait", "Waiting time", "s", a?.waitS, r?.waitS, true, "runs.csv"),
    row("stops", "Stops", "", a?.stops, r?.stops, true, "runs.csv"),
    row("redStops", "Red-light stops", "", a?.redStops, r?.redStops, true, "runs.csv"),
    row("preemptions", "Signals preempted", "", a?.preemptions, r?.preemptions, null, "runs.csv"),
    row("routeChanges", "Route changes", "", a?.routeChanges, r?.routeChanges, null, "runs.csv"),
    row("distance", "Distance driven", "m", drivenMetres(actual), drivenMetres(reference), null, "recorded track"),
  ];
  let timeSaved: number | null = null;
  let reason = "";
  if (a === null || r === null) reason = "A run is missing from runs.csv.";
  else if (!a.arrived || !r.arrived) reason = "A run did not arrive: no time saved is computed.";
  else if (a.travelS === null || r.travelS === null) reason = "Travel time not recorded.";
  else timeSaved = r.travelS - a.travelS;
  return { comparable: true, reason, rows, timeSaved };
}

/**
 * Choosing a run: the header's dropdowns (scenario, demand, signals, routing, seed) pick one entry
 * of the index, and the comparison run defaults to the OFF baseline of the same seed (the "ghost").
 */
import type { ReplayIndexRunMsg, ResultSignals, Routing } from "../simulation/state";

export const BASELINE_ARM = "off_strict_static";

export const STRATEGY_LABEL: Record<ResultSignals, string> = {
  off_strict: "OFF (obeys red)",
  off_realistic: "OFF (crosses red)",
  basic: "BASIC",
  coord: "COORD",
};

export const STRATEGY_ORDER: ResultSignals[] = ["off_strict", "off_realistic", "basic", "coord"];

export function armLabel(strategy: ResultSignals, routing: Routing): string {
  return `${STRATEGY_LABEL[strategy]} · ${routing}`;
}

export interface Choice {
  scenario: string;
  scale: number;
  strategy: ResultSignals;
  routing: Routing;
  seed: number;
}

export const unique = <T>(values: T[]): T[] => [...new Set(values)];

export function choiceOf(run: ReplayIndexRunMsg): Choice {
  return { scenario: run.scenario, scale: run.scale, strategy: run.strategy, routing: run.routing, seed: run.seed };
}

export function findRun(runs: readonly ReplayIndexRunMsg[], c: Choice): ReplayIndexRunMsg | null {
  return (
    runs.find(
      (r) =>
        r.scenario === c.scenario &&
        r.scale === c.scale &&
        r.strategy === c.strategy &&
        r.routing === c.routing &&
        r.seed === c.seed,
    ) ?? null
  );
}

/** The run of the same traffic seed to compare against: the OFF baseline, else null. */
export function baselineFor(runs: readonly ReplayIndexRunMsg[], run: ReplayIndexRunMsg): ReplayIndexRunMsg | null {
  return (
    runs.find((r) => r.arm === BASELINE_ARM && r.scenario === run.scenario && r.scale === run.scale && r.seed === run.seed) ??
    null
  );
}

/** Every other arm of the same seed, to compare any two runs. */
export function siblingsOf(runs: readonly ReplayIndexRunMsg[], run: ReplayIndexRunMsg): ReplayIndexRunMsg[] {
  return runs.filter((r) => r.scenario === run.scenario && r.scale === run.scale && r.seed === run.seed && r.id !== run.id);
}

/**
 * The run to open first: the demo's heavy-traffic setting with BASIC if it has a recorded
 * playback, else any run with one, else the first run.
 */
export function defaultRun(runs: readonly ReplayIndexRunMsg[]): ReplayIndexRunMsg | null {
  const recorded = runs.filter((r) => r.telemetry);
  return (
    recorded.find((r) => r.scale === 1.5 && r.arm === "coord_dynamic" && r.seed === 1) ??
    recorded.find((r) => r.scale === 1.5 && r.strategy !== "off_strict") ??
    recorded[0] ??
    runs[0] ??
    null
  );
}

/** Options for a dropdown given the other choices: values for which a run exists. */
export function optionsFor(runs: readonly ReplayIndexRunMsg[], c: Choice, field: keyof Choice): (string | number)[] {
  const matching = runs.filter((r) =>
    (Object.keys(c) as (keyof Choice)[]).every((key) => key === field || choiceOf(r)[key] === c[key]),
  );
  return unique(matching.map((r) => choiceOf(r)[field])).sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))));
}

/**
 * The choice nearest to `wanted` that exists. The field the user just changed wins; the others
 * keep their value while a run with it exists. A seed is kept only if it was changed on purpose
 * or has a recorded playback: otherwise the nearest seed that has one is taken.
 */
export function resolveChoice(runs: readonly ReplayIndexRunMsg[], wanted: Choice, changed: keyof Choice): Choice | null {
  const order: (keyof Choice)[] = [changed, "scenario", "scale", "strategy", "routing"].filter(
    (f, i, all) => f !== "seed" && all.indexOf(f) === i,
  ) as (keyof Choice)[];
  let pool = [...runs];
  for (const field of order) {
    const narrowed = pool.filter((r) => choiceOf(r)[field] === wanted[field]);
    if (narrowed.length > 0) pool = narrowed;
  }
  if (pool.length === 0) return null;
  const exact = pool.find((r) => r.seed === wanted.seed);
  if (exact && (changed === "seed" || exact.telemetry)) return choiceOf(exact);
  const recorded = pool.filter((r) => r.telemetry);
  const candidates = recorded.length > 0 ? recorded : pool;
  const nearest = [...candidates].sort((a, b) => Math.abs(a.seed - wanted.seed) - Math.abs(b.seed - wanted.seed))[0];
  return choiceOf(exact && recorded.length === 0 ? exact : nearest);
}

/** An arm id such as "coord_dynamic" as its strategy and routing. */
export function splitArm(arm: string): { strategy: ResultSignals; routing: Routing } {
  const at = arm.lastIndexOf("_");
  return { strategy: arm.slice(0, at) as ResultSignals, routing: arm.slice(at + 1) as Routing };
}

export function armName(arm: string): string {
  const { strategy, routing } = splitArm(arm);
  return armLabel(strategy, routing);
}

export interface DeepLink {
  run: string | null;
  ref: string | null;
  t: number | null;
}

/** /replay?run=basic_dynamic/grid4x4_x1.5_seed003&ref=off_strict_static/...&t=40 */
export function parseDeepLink(search: string): DeepLink {
  const params = new URLSearchParams(search);
  const time = Number(params.get("t"));
  return {
    run: params.get("run"),
    ref: params.get("ref"),
    t: params.get("t") !== null && Number.isFinite(time) && time >= 0 ? time : null,
  };
}

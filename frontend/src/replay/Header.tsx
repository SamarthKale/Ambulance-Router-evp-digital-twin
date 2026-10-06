import { useMemo } from "react";

import { clock, SPEEDS, useClockPlaying, useClockSpeed, useClockTime } from "./clock";
import { clockText } from "./format";
import { missionState, nextEvent, previousEvent } from "./playback";
import { indexRun, referenceId, runInfo, useReplay } from "./replayStore";
import {
  armLabel,
  baselineFor,
  choiceOf,
  optionsFor,
  resolveChoice,
  siblingsOf,
  STRATEGY_LABEL,
  findRun,
  type Choice,
} from "./runs";
import type { ResultSignals, Routing } from "../simulation/state";

function Select<T extends string | number>({
  label,
  value,
  options,
  show,
  onChange,
}: {
  label: string;
  value: T;
  options: T[];
  show?: (v: T) => string;
  onChange: (v: T) => void;
}) {
  return (
    <label className="sel">
      <span>{label}</span>
      <select
        value={String(value)}
        onChange={(e) => {
          const picked = options.find((o) => String(o) === e.target.value);
          if (picked !== undefined) onChange(picked);
        }}
      >
        {options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {show ? show(o) : String(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function RunSelector() {
  const index = useReplay((s) => s.index);
  const selectedId = useReplay((s) => s.selectedId);
  const compareWith = useReplay((s) => s.compareWith);
  const select = useReplay((s) => s.select);
  const setCompareWith = useReplay((s) => s.setCompareWith);
  const current = indexRun(index, selectedId);
  const runs = index?.runs ?? [];
  const choice = current ? choiceOf(current) : null;

  const pick = (field: keyof Choice, value: string | number): void => {
    if (!choice) return;
    const chosen = resolveChoice(runs, { ...choice, [field]: value } as Choice, field);
    const run = chosen ? findRun(runs, chosen) : null;
    if (run) select(run.id);
  };
  const siblings = useMemo(() => (current ? siblingsOf(runs, current) : []), [runs, current]);
  const baseline = current ? baselineFor(runs, current) : null;

  if (!current || !choice) return <div className="selectors muted">No run selected</div>;
  const seeds = optionsFor(runs, choice, "seed") as number[];
  const recorded = new Set(runs.filter((r) => r.telemetry && r.scenario === choice.scenario && r.scale === choice.scale && r.strategy === choice.strategy && r.routing === choice.routing).map((r) => r.seed));
  return (
    <div className="selectors">
      <Select label="Scenario" value={choice.scenario} options={optionsFor(runs, choice, "scenario") as string[]} onChange={(v) => pick("scenario", v)} />
      <Select label="Demand" value={choice.scale} options={optionsFor(runs, choice, "scale") as number[]} show={(v) => `×${v}`} onChange={(v) => pick("scale", v)} />
      <Select
        label="Signals (mode)"
        value={choice.strategy}
        options={optionsFor(runs, choice, "strategy") as ResultSignals[]}
        show={(v) => STRATEGY_LABEL[v]}
        onChange={(v) => pick("strategy", v)}
      />
      <Select label="Routing" value={choice.routing} options={optionsFor(runs, choice, "routing") as Routing[]} show={(v) => v.toUpperCase()} onChange={(v) => pick("routing", v)} />
      <Select label="Seed" value={choice.seed} options={seeds} show={(v) => `${v}${recorded.has(v) ? " ●" : ""}`} onChange={(v) => pick("seed", v)} />
      <label className="sel">
        <span>Compare with</span>
        <select value={compareWith} onChange={(e) => setCompareWith(e.target.value)}>
          <option value="baseline">{baseline && baseline.id !== current.id ? "OFF ghost (baseline of this seed)" : "— (this is the baseline)"}</option>
          <option value="none">None</option>
          {siblings
            .filter((r) => r.id !== baseline?.id)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {armLabel(r.strategy, r.routing)}
                {r.telemetry ? " ●" : ""}
              </option>
            ))}
        </select>
      </label>
      <span className="muted small" title="● = a playback was recorded">● recorded playback</span>
    </div>
  );
}

export function PlaybackControls() {
  const playing = useClockPlaying();
  const speed = useClockSpeed();
  const t = useClockTime(10);
  const index = useReplay((s) => s.index);
  const selectedId = useReplay((s) => s.selectedId);
  const compareWith = useReplay((s) => s.compareWith);
  const loads = useReplay((s) => s.loads);
  const requestView = useReplay((s) => s.requestView);
  const primary = runInfo(index, loads, selectedId);
  const refId = referenceId(index, selectedId, compareWith);
  const reference = runInfo(index, loads, refId);
  const pb = primary?.playback ?? reference?.playback ?? null;
  const hasTrack = pb !== null;

  const jump = (target: number): void => {
    clock.seek(target);
    requestView({ kind: "ambulance" });
  };
  return (
    <div className="controls" role="group" aria-label="Playback">
      <button disabled={!hasTrack} title="Previous event (←)" onClick={() => { const e = pb && previousEvent(pb, clock.t); if (e) jump(e.t); }}>⏮</button>
      <button disabled={!hasTrack} className="primary" title="Play / pause (space)" onClick={() => clock.toggle()}>
        {playing ? "⏸ Pause" : "▶ Play"}
      </button>
      <button disabled={!hasTrack} title="Restart (Home)" onClick={() => clock.restart()}>↻ Restart</button>
      <button disabled={!hasTrack} title="Next event (→)" onClick={() => { const e = pb && nextEvent(pb, clock.t); if (e) jump(e.t); }}>⏭</button>
      <label className="sel inline" title="Playback speed">
        <span>Speed</span>
        <select value={String(speed)} onChange={(e) => clock.setSpeed(Number(e.target.value))}>
          {SPEEDS.map((v) => (
            <option key={v} value={String(v)}>
              {v}×
            </option>
          ))}
        </select>
      </label>
      <span className={`status-pill ${primary?.playback ? missionState(primary.playback, t) : "none"}`} title="Mission status at the playback time">
        {primary?.playback ? (missionState(primary.playback, t) === "arrived" ? "ARRIVED" : "DRIVING") : "NO PLAYBACK"}
      </span>
      <span className="readout">
        {clockText(t)} / {clockText(clock.duration)}
      </span>
    </div>
  );
}

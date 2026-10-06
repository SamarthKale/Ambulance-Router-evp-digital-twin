import { useEffect, useMemo, useRef, useState } from "react";

import { clock, useClockTime } from "./clock";
import type { Comparison, RunInfo } from "./compare";
import { clockText, count, KIND_COLOR, KIND_LABEL, NOT_RECORDED, num, signed } from "./format";
import { lineLength, type MapGeometry } from "./mapGeometry";
import { LAMP_COLOR } from "./mapStyle";
import {
  edgeSampleIndex,
  eventsUpTo,
  lampOf,
  MAJOR_KINDS,
  poseAt,
  preemptionAt,
  signalAt,
  stageLabel,
  statusAt,
} from "./playback";
import { useReplay } from "./replayStore";
import { armLabel, armName } from "./runs";
import { safetyStatus } from "./safety";
import { searchAll, type SearchResult } from "./search";
import { KMH } from "./charts";
import type { ReplayEventMsg, ReplayIndexRunMsg, ResultArmMsg, ResultExperimentMsg } from "../simulation/state";

function Stat({ label, value, tone, title }: { label: string; value: React.ReactNode; tone?: "good" | "bad" | "warn"; title?: string }) {
  return (
    <div className="stat" title={title}>
      <span className="muted">{label}</span>
      <strong className={tone ?? ""}>{value}</strong>
    </div>
  );
}

function Card({ title, badge, children, className }: { title: string; badge?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rcard ${className ?? ""}`}>
      <h2>
        {title}
        {badge && <span className="tag">{badge}</span>}
      </h2>
      {children}
    </section>
  );
}

// ---- left panel ---------------------------------------------------------------------------
export function RunCard({ run, entry }: { run: RunInfo; entry: ReplayIndexRunMsg }) {
  const playback = run.playback?.run;
  const s = run.summary;
  return (
    <Card title="Run" badge="DEMO PLAYBACK">
      <Stat label="arm" value={armLabel(entry.strategy, entry.routing)} />
      <Stat label="scenario · demand · seed" value={`${entry.scenario} · ×${entry.scale} · ${entry.seed}`} />
      <Stat label="mission" value={s ? `${s.origin} → ${s.destination}` : NOT_RECORDED} />
      <Stat label="dispatched at" value={s ? num(s.dispatchS, 1, "s sim time") : NOT_RECORDED} title="Simulation time of the dispatch; the playback starts here (t = 0)" />
      <Stat label="signal plan" value={s ? `${s.signalProgram}, cycle ${num(s.cycleS, 1, "s")}` : NOT_RECORDED} />
      <Stat
        label="source"
        value={
          playback ? (playback.verification.matchesRecorded ? "re-run matches runs.csv ✓" : "re-run DIFFERS from runs.csv")
          : entry.telemetry ? "loading…" : "runs.csv only (no playback)"
        }
        tone={playback ? (playback.verification.matchesRecorded ? "good" : "bad") : "warn"}
        title="The playback is a deterministic re-run of the recorded run, checked field by field against its runs.csv row"
      />
    </Card>
  );
}

export function MissionCard({ run }: { run: RunInfo }) {
  const t = useClockTime(10);
  const pb = run.playback;
  const s = run.summary;
  const pose = pb ? poseAt(pb, t) : null;
  const status = pb ? statusAt(pb, t) : null;
  const events = pb ? eventsUpTo(pb, t) : [];
  const arrived = events.some((e) => e.kind === "arrival");
  const preemptedSoFar = events.filter((e) => e.kind === "preempt" && e.accepted).length;
  const reroutesSoFar = events.filter((e) => e.kind === "reroute").length;
  const state = !pb ? NOT_RECORDED : arrived ? "Arrived" : "Driving";
  return (
    <Card title="Mission">
      <Stat label="elapsed" value={pb ? clockText(t) : NOT_RECORDED} />
      <Stat label="state" value={state} tone={arrived ? "good" : undefined} />
      <Stat label="speed" value={pose ? `${(pose.speed * KMH).toFixed(0)} km/h` : NOT_RECORDED} />
      <Stat label="road · lane" value={pose ? `${pose.edge} · ${pose.lane}` : NOT_RECORDED} />
      <Stat label="distance driven" value={status ? num(status.driven, 0, "m") : NOT_RECORDED} title="Summed from the recorded positions" />
      <Stat label="distance remaining" value={status ? num(status.distanceLeft, 0, "m") : NOT_RECORDED} title="Along the suggested route, as the simulation reported it" />
      <Stat label="ETA" value={status ? num(status.eta, 1, "s") : NOT_RECORDED} />
      <Stat label="signals preempted" value={pb ? `${preemptedSoFar} of ${count(s?.preemptions)}` : count(s?.preemptions)} />
      <Stat label="reroutes" value={pb ? `${reroutesSoFar} of ${count(s?.routeChanges)}` : count(s?.routeChanges)} />
      <Stat label="stops (whole mission)" value={count(s?.stops)} />
      <Stat label="safety violations" value={count(s?.violations)} tone={s?.violations ? "bad" : s ? "good" : undefined} />
      <Stat label="collisions (any vehicles)" value={count(s?.collisions)} tone={s?.collisions ? "warn" : undefined} />
    </Card>
  );
}

export function SignalCard({ run, geometry }: { run: RunInfo; geometry: MapGeometry }) {
  const id = useReplay((s) => s.selectedSignal);
  const t = useClockTime(10);
  const requestView = useReplay((s) => s.requestView);
  const pb = run.playback;
  if (!id) return null;
  const sig = pb ? signalAt(pb, id, t) : null;
  const segments = pb?.preemptions.filter((p) => p.junction === id) ?? [];
  const approaches = geometry.approachesByJunction.get(id) ?? [];
  const here = pb ? preemptionAt(pb, id, t) : null;
  const reasons = (pb?.events ?? []).filter((e) => e.junction === id && (e.kind === "preempt" || e.kind === "release" || e.kind === "resume"));
  return (
    <Card title={`Signal ${id}`} badge={sig ? stageLabel(sig.control, sig.state) : NOT_RECORDED}>
      <Stat label="junction" value={id} />
      <Stat label="stage now" value={sig ? stageLabel(sig.control, sig.state) : NOT_RECORDED} tone={sig && sig.control !== "program" ? "warn" : undefined} />
      <Stat label="held by the controller now" value={here ? `${here.start.toFixed(1)}–${here.end.toFixed(1)} s` : pb ? "no" : NOT_RECORDED} />
      <div className="approaches">
        {approaches.map((a) => {
          const lamp = sig ? lampOf(sig.state, a.links) : null;
          return (
            <div key={a.edge} className="approach">
              <span className="dot" style={{ background: lamp ? LAMP_COLOR[lamp] : "#64748b" }} />
              <span>{a.edge}</span>
              <span className="muted">{lamp ?? NOT_RECORDED}</span>
            </div>
          );
        })}
      </div>
      {segments.length > 0 && (
        <>
          <div className="muted small">Preemption windows recorded</div>
          <ul className="plain">
            {segments.map((p) => (
              <li key={p.start}>
                <button className="link" onClick={() => { clock.seek(p.start); requestView({ kind: "junction", id }); }}>
                  {p.start.toFixed(1)}–{p.end.toFixed(1)} s{p.reachedGreen ? " (green held)" : ""}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {reasons.length > 0 && (
        <>
          <div className="muted small">Controller log for this junction</div>
          <ul className="plain small">
            {reasons.slice(0, 6).map((e) => (
              <li key={`${e.t}-${e.kind}`}>
                <span className="muted">{e.t.toFixed(1)} s</span> {KIND_LABEL[e.kind] ?? e.kind}: {e.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

export function EdgeCard({ run, geometry }: { run: RunInfo; geometry: MapGeometry }) {
  const id = useReplay((s) => s.selectedEdge);
  const t = useClockTime(10);
  const pb = run.playback;
  if (!id) return null;
  const line = geometry.edgeLine.get(id);
  const length = line ? lineLength(line) : null;
  const column = pb ? pb.run.edges.ids.indexOf(id) : -1;
  const sampleIndex = pb ? edgeSampleIndex(pb, t) : 0;
  const sample = pb?.run.edges.samples[sampleIndex];
  const known = sample !== undefined && column >= 0;
  const speed = known ? sample.speed[column] : null;
  const travel = length !== null && speed !== null && speed > 0.3 ? length / speed : null;
  return (
    <Card title={`Road ${id}`} badge={known ? `sample at ${sample.t.toFixed(0)} s` : NOT_RECORDED}>
      <Stat label="length" value={num(length, 0, "m")} />
      <Stat label="lanes" value={line ? String(Math.round((geometry.edgeWidth.get(id) ?? 0) / 3.2)) : NOT_RECORDED} />
      <Stat label="vehicles" value={known ? count(sample.vehicles[column]) : NOT_RECORDED} />
      <Stat label="halted (queue)" value={known ? count(sample.halting[column]) : NOT_RECORDED} tone={known && sample.halting[column] > 3 ? "warn" : undefined} />
      <Stat label="mean speed" value={known ? num(speed === null ? null : speed * KMH, 0, "km/h") : NOT_RECORDED} />
      <Stat
        label="time to drive it"
        value={travel !== null ? num(travel, 0, "s") : known ? "stopped / empty" : NOT_RECORDED}
        title="Road length divided by the recorded mean speed; per-road counts are recorded every 5 s"
      />
    </Card>
  );
}

export function SearchBox({ run, geometry }: { run: RunInfo; geometry: MapGeometry }) {
  const [query, setQuery] = useState("");
  const requestView = useReplay((s) => s.requestView);
  const set = useReplay((s) => s.set);
  const results = useMemo(
    () => searchAll(query, geometry.signalIds, geometry.edgeIds, run.playback?.events ?? []),
    [query, geometry, run.playback],
  );
  const open = (r: SearchResult): void => {
    if (r.type === "junction") {
      set({ selectedSignal: r.id, selectedEdge: null });
      requestView({ kind: "junction", id: r.id });
    } else if (r.type === "edge") {
      set({ selectedEdge: r.id, selectedSignal: null });
      requestView({ kind: "edge", id: r.id });
    } else if (r.t !== undefined) {
      clock.seek(r.t);
      requestView({ kind: "ambulance" });
    }
    setQuery("");
  };
  return (
    <div className="search">
      <input
        type="search"
        placeholder="Search A0, reroute, accident…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search"
      />
      {results.length > 0 && (
        <ul className="results">
          {results.map((r) => (
            <li key={`${r.type}-${r.id}`}>
              <button onClick={() => open(r)}>
                <span className="tag">{r.type}</span> {r.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {query.trim() !== "" && results.length === 0 && <div className="muted small pad">Nothing matches “{query}”.</div>}
    </div>
  );
}

// ---- right panel --------------------------------------------------------------------------
function Bar({ value, max, color }: { value: number | null; max: number; color: string }) {
  const width = value === null || max <= 0 ? 0 : Math.max(2, (value / max) * 100);
  return (
    <span className="bar">
      <span style={{ width: `${width}%`, background: color }} />
    </span>
  );
}

export function ComparisonCard({ run, reference, comparison }: { run: RunInfo; reference: RunInfo | null; comparison: Comparison }) {
  const t = useClockTime(4);
  const label = armName(run.arm);
  const refLabel = reference ? armName(reference.arm) : "";
  const pose = (info: RunInfo | null) => (info?.playback ? statusAt(info.playback, t).driven : null);
  const saved = comparison.timeSaved;
  return (
    <Card title="Actual vs reference" badge="FROM TWO RECORDED RUNS">
      {!comparison.comparable && <div className="muted">{comparison.reason}</div>}
      {comparison.comparable && (
        <>
          <div className={`saved ${saved === null ? "none" : saved >= 0 ? "good" : "bad"}`}>
            <span className="label">{saved !== null && saved < 0 ? "TIME LOST" : "TIME SAVED"}</span>
            <strong>{saved === null ? NOT_RECORDED : `${Math.abs(saved).toFixed(1)} s`}</strong>
            <span className="muted small">
              {saved === null ? comparison.reason : `reference ${num(reference?.summary?.travelS, 1, "s")} − actual ${num(run.summary?.travelS, 1, "s")}, both recorded`}
            </span>
          </div>
          <div className="legend2">
            <span><i style={{ background: "#38bdf8" }} /> ACTUAL · {label}</span>
            <span><i style={{ background: "#cbd5e1" }} /> OFF GHOST · {refLabel}</span>
          </div>
          <table className="cmp">
            <tbody>
              {comparison.rows.map((row) => {
                const max = Math.max(row.actual ?? 0, row.reference ?? 0);
                const good = row.delta === null || row.lowerIsBetter === null ? "" : (row.delta < 0) === row.lowerIsBetter ? "good" : row.delta === 0 ? "" : "bad";
                return (
                  <tr key={row.key} title={`source: ${row.source}`}>
                    <th>{row.label}</th>
                    <td>
                      <Bar value={row.actual} max={max} color="#38bdf8" />
                      <Bar value={row.reference} max={max} color="#cbd5e1" />
                    </td>
                    <td className="nums">
                      <div>{row.actual === null ? NOT_RECORDED : `${row.actual.toFixed(row.unit === "s" ? 1 : 0)}${row.unit ? ` ${row.unit}` : ""}`}</div>
                      <div className="muted">{row.reference === null ? NOT_RECORDED : row.reference.toFixed(row.unit === "s" ? 1 : 0)}</div>
                    </td>
                    <td className={`delta ${good}`}>{row.delta === null ? "" : signed(row.delta, row.unit === "s" ? 1 : 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="muted small">
            Now (t = {t.toFixed(1)} s): driven {num(pose(run), 0, "m")} vs {num(pose(reference), 0, "m")} for the reference.
          </div>
        </>
      )}
    </Card>
  );
}

export function SafetyCard({ run }: { run: RunInfo }) {
  const verification = run.playback?.run.verification ?? null;
  const status = safetyStatus(run.summary, verification);
  const s = run.summary;
  return (
    <Card title="Safety status" badge="INDEPENDENT MONITOR + SUMO">
      <div className={`safety ${status.level}`}>{status.headline}</div>
      <ul className="plain small">
        {status.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <Stat label="monitor violations" value={count(s?.violations)} />
      <Stat label="collisions (any vehicles, 600 s window)" value={count(s?.collisions)} />
      <Stat label="ambulance collisions" value={s?.ambulanceCollisions === null || s === null ? "not classified" : count(s?.ambulanceCollisions)} />
      <Stat label="emergency brakings" value={count(s?.emergencyBrakings)} />
    </Card>
  );
}

const ROW_H = 44;

export function EventLog({ run }: { run: RunInfo }) {
  const t = useClockTime(4);
  const requestView = useReplay((s) => s.requestView);
  const [majorOnly, setMajorOnly] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 240 });
  const events = useMemo(() => {
    const all = run.playback?.events ?? [];
    return majorOnly ? all.filter((e) => MAJOR_KINDS.has(e.kind)) : all;
  }, [run.playback, majorOnly]);
  const current = events.reduce((n, e, i) => (e.t <= t ? i : n), -1);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = (): void => setScroll({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // keep the current event in view while playing
  useEffect(() => {
    const el = box.current;
    if (!el || current < 0 || !clock.playing) return;
    const top = current * ROW_H;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - ROW_H);
  }, [current]);

  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - 2);
  const last = Math.min(events.length, Math.ceil((scroll.top + scroll.height) / ROW_H) + 2);
  const open = (e: ReplayEventMsg): void => {
    clock.seek(e.t);
    if (e.junction) {
      useReplay.getState().set({ selectedSignal: e.junction });
      requestView({ kind: "junction", id: e.junction });
    } else requestView({ kind: "ambulance" });
  };
  return (
    <Card title="Events and decisions" badge={`${events.length}`} className="grow">
      <label className="check small">
        <input type="checkbox" checked={majorOnly} onChange={(e) => setMajorOnly(e.target.checked)} /> major events only
      </label>
      {!run.playback && <div className="muted">{NOT_RECORDED}</div>}
      <div className="events" ref={box} onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
        <div style={{ height: events.length * ROW_H, position: "relative" }}>
          {events.slice(first, last).map((e, k) => {
            const i = first + k;
            return (
              <button
                key={`${e.t}-${e.kind}-${e.junction ?? ""}-${i}`}
                className={`event ${i === current ? "now" : ""} ${e.t > t ? "future" : ""}`}
                style={{ top: i * ROW_H, height: ROW_H - 4, borderLeftColor: KIND_COLOR[e.kind] ?? "#64748b" }}
                onClick={() => open(e)}
                title={e.text}
              >
                <span className="muted">{e.t.toFixed(1)} s</span>
                <strong>{KIND_LABEL[e.kind] ?? e.kind}</strong>
                {e.junction && <span className="tag">{e.junction}</span>}
                {e.accepted === false && <span className="tag bad">rejected</span>}
                <span className="text">{e.text}</span>
              </button>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

export function ExperimentCard({ entry }: { entry: ReplayIndexRunMsg }) {
  const results = useReplay((s) => s.results);
  if (!results || !results.available) {
    return (
      <Card title="Experimental results" badge="BATCH">
        <div className="muted">{NOT_RECORDED}: no batch summary is available.</div>
      </Card>
    );
  }
  const experiment: ResultExperimentMsg | undefined = results.experiments.find((e) => e.scenario === entry.scenario && e.scale === entry.scale);
  const arm: ResultArmMsg | undefined = experiment?.arms.find((a) => a.arm === entry.arm);
  if (!experiment || !arm) {
    return (
      <Card title="Experimental results" badge="BATCH">
        <div className="muted">{NOT_RECORDED} for this scenario and demand.</div>
      </Card>
    );
  }
  const vs = arm.travelVsBaseline;
  return (
    <Card title="Experimental results" badge={`BATCH OF ${experiment.seeds.length} SEEDS`}>
      <div className="muted small">Statistics over all seeds of this arm. They are not the single run played above.</div>
      <Stat label="runs · valid · failed" value={`${arm.runs} · ${arm.valid} · ${arm.runs - arm.valid}`} />
      <Stat label="mean travel time" value={`${num(arm.travelMean, 1, "s")}  [${num(arm.travelCi[0], 1)}, ${num(arm.travelCi[1], 1)}]`} />
      <Stat
        label="vs baseline (paired)"
        value={vs && vs.meanDiff !== null ? `${signed(vs.meanDiff, 1, "s")}  [${num(vs.ci[0], 1)}, ${num(vs.ci[1], 1)}], p = ${vs.p === null ? "n/a" : vs.p < 0.001 ? "<0.001" : vs.p.toFixed(3)}` : "this is the baseline"}
      />
      <Stat label="monitor violations (all runs)" value={arm.safety.violations} tone={arm.safety.violations ? "bad" : "good"} />
      <Stat label="ambulance collisions (all runs)" value={arm.safety.ambulanceCollisions === null ? "not classified" : arm.safety.ambulanceCollisions} />
    </Card>
  );
}

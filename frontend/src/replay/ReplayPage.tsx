/**
 * /replay: a command-centre playback of the recorded experiment runs (Sprint 11). It is read-only
 * and never live: every position, signal state, route, queue and event comes from the telemetry
 * recorded from the simulation (experiments/telemetry), and every result from runs.csv.
 */
import { useEffect, useMemo, useState } from "react";

import "./replay.css";
import { ChartsPanel, Timeline } from "./Bottom";
import { clock, useClockTime } from "./clock";
import { compareRuns, type Comparison, type RunInfo } from "./compare";
import { NOT_RECORDED, num } from "./format";
import { Header } from "./HeaderBar";
import { MapCanvas } from "./MapCanvas";
import type { MapGeometry } from "./mapGeometry";
import { HEAT_LEGEND, LAMP_COLOR, COLORS } from "./mapStyle";
import {
  ComparisonCard,
  EdgeCard,
  EventLog,
  ExperimentCard,
  MissionCard,
  RunCard,
  SafetyCard,
  SearchBox,
  SignalCard,
} from "./Panels";
import { nextEvent, previousEvent, signalAt, stageLabel } from "./playback";
import { indexRun, referenceId, runInfo, useReplay, type Follow, type Heat } from "./replayStore";
import { armName } from "./runs";

const labelOf = (run: RunInfo | null): string => (run ? armName(run.arm) : "");

export function ReplayPage() {
  const init = useReplay((s) => s.init);
  const index = useReplay((s) => s.index);
  const indexError = useReplay((s) => s.indexError);
  const selectedId = useReplay((s) => s.selectedId);
  const compareWith = useReplay((s) => s.compareWith);
  const loads = useReplay((s) => s.loads);
  const geometries = useReplay((s) => s.geometries);
  const demo = useReplay((s) => s.demo);
  const ensureRun = useReplay((s) => s.ensureRun);
  const [panels, setPanels] = useState({ left: true, right: true, bottom: true });

  useEffect(() => {
    void init();
  }, [init]);

  const entry = indexRun(index, selectedId);
  const refId = referenceId(index, selectedId, compareWith);
  const primary = useMemo(() => runInfo(index, loads, selectedId), [index, loads, selectedId]);
  const reference = useMemo(() => runInfo(index, loads, refId), [index, loads, refId]);
  const comparison = useMemo<Comparison | null>(() => (primary ? compareRuns(primary, reference) : null), [primary, reference]);
  const geometry = entry ? geometries[entry.scenario] : undefined;
  const duration = Math.max(primary?.playback?.duration ?? 0, reference?.playback?.duration ?? 0);

  useEffect(() => {
    if (refId) ensureRun(refId);
  }, [refId, ensureRun]);
  useEffect(() => {
    clock.setDuration(duration);
  }, [duration]);

  // the clock runs on animation frames; everything else reads it
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      clock.advance((now - last) / 1000);
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  // a hidden tab must not run the playback ahead
  useEffect(() => {
    const onHide = (): void => {
      if (document.hidden) clock.pause();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement | null)?.closest("input, select, textarea")) return;
      const pb = primary?.playback ?? reference?.playback ?? null;
      const store = useReplay.getState();
      if (e.code === "Space") {
        e.preventDefault();
        clock.toggle();
      } else if (e.code === "Home") clock.restart();
      else if (e.code === "ArrowRight" && pb) {
        const ev = nextEvent(pb, clock.t);
        if (ev) {
          clock.seek(ev.t);
          store.requestView({ kind: "ambulance" });
        }
      } else if (e.code === "ArrowLeft" && pb) {
        const ev = previousEvent(pb, clock.t);
        if (ev) {
          clock.seek(ev.t);
          store.requestView({ kind: "ambulance" });
        }
      } else if (e.code === "KeyD") store.set({ demo: !store.demo });
      else if (e.code === "Equal" || e.code === "NumpadAdd") store.requestView({ kind: "zoom", factor: 1.4 });
      else if (e.code === "Minus" || e.code === "NumpadSubtract") store.requestView({ kind: "zoom", factor: 1 / 1.4 });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [primary, reference]);

  return (
    <div className={`replay ${demo ? "demo" : ""} ${panels.left ? "" : "no-left"} ${panels.right ? "" : "no-right"} ${panels.bottom ? "" : "no-bottom"}`}>
      <Header />
      <main className="rp-main">
        {!demo && panels.left && (
          <aside className="rp-left" aria-label="Mission and signals">
            {entry && primary && geometry && typeof geometry !== "string" && (
              <>
                <SearchBox run={primary} geometry={geometry} />
                <RunCard run={primary} entry={entry} />
                <MissionCard run={primary} />
                <SignalCard run={primary} geometry={geometry} />
                <EdgeCard run={primary} geometry={geometry} />
              </>
            )}
          </aside>
        )}
        <section className="rp-center">
          {indexError && !entry && <div className="notice big">Replay data unavailable: {indexError}. Is the backend running? Recorded runs come from experiments/telemetry.</div>}
          {!indexError && !entry && <div className="notice big muted">Loading recorded runs…</div>}
          {entry && primary && (
            <MapStage
              geometry={geometry}
              primary={primary}
              reference={reference}
              comparison={comparison}
              panels={panels}
              setPanels={setPanels}
            />
          )}
        </section>
        {!demo && panels.right && (
          <aside className="rp-right" aria-label="Comparison, safety and events">
            {entry && primary && comparison && (
              <>
                <ComparisonCard run={primary} reference={reference} comparison={comparison} />
                <SafetyCard run={primary} />
                <EventLog run={primary} />
                <ExperimentCard entry={entry} />
              </>
            )}
          </aside>
        )}
      </main>
      {panels.bottom && primary && (
        <footer className="rp-bottom">
          <Timeline run={primary} reference={reference} />
          {!demo && <ChartsPanel run={primary} reference={reference} />}
        </footer>
      )}
    </div>
  );
}

function MapStage({
  geometry,
  primary,
  reference,
  comparison,
  panels,
  setPanels,
}: {
  geometry: MapGeometry | "loading" | "error" | undefined;
  primary: RunInfo;
  reference: RunInfo | null;
  comparison: Comparison | null;
  panels: { left: boolean; right: boolean; bottom: boolean };
  setPanels: (p: { left: boolean; right: boolean; bottom: boolean }) => void;
}) {
  const layout = useReplay((s) => s.layout);
  const demo = useReplay((s) => s.demo);
  const showGhost = useReplay((s) => s.showGhost);
  const heat = useReplay((s) => s.heat);
  const noPlayback = primary.playback === null;
  return (
    <div className="stage">
      {!demo && <MapToolbar primary={primary} reference={reference} panels={panels} setPanels={setPanels} />}
      <div className={`maps ${layout === "split" && reference ? "split" : ""}`}>
        <div className="map-pane">
          {geometry === undefined || geometry === "loading" ? (
            <div className="notice big muted">Loading the road map…</div>
          ) : geometry === "error" ? (
            <div className="notice big">The road geometry could not be loaded.</div>
          ) : (
            <MapCanvas
              geometry={geometry}
              focus={primary}
              other={layout === "overlay" && showGhost ? reference : null}
              otherLabel={reference ? `OFF ghost · ${labelOf(reference)}` : ""}
            />
          )}
          <div className="chip actual">ACTUAL · {labelOf(primary)}</div>
          {noPlayback && (
            <div className="notice">
              <strong>Playback not recorded for this run.</strong>
              <span>Its recorded result (runs.csv) is shown in the panels; no positions are invented. Runs marked ● have a playback.</span>
            </div>
          )}
          <MapLegend heat={heat} />
          {demo && comparison && <DemoOverlay primary={primary} reference={reference} comparison={comparison} />}
          <EventToast run={primary} />
        </div>
        {layout === "split" && reference && geometry && typeof geometry !== "string" && (
          <div className="map-pane">
            <MapCanvas geometry={geometry} focus={reference} other={null} otherLabel="" />
            <div className="chip ghost">REFERENCE · {labelOf(reference)}</div>
            {reference.playback === null && (
              <div className="notice">
                <strong>Playback not recorded for the reference run.</strong>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange, disabled, title }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string }) {
  return (
    <label className={`check ${disabled ? "off" : ""}`} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

function MapToolbar({
  primary,
  reference,
  panels,
  setPanels,
}: {
  primary: RunInfo;
  reference: RunInfo | null;
  panels: { left: boolean; right: boolean; bottom: boolean };
  setPanels: (p: { left: boolean; right: boolean; bottom: boolean }) => void;
}) {
  const s = useReplay();
  const hasTrack = primary.playback !== null;
  const hasTraffic = primary.playback?.traffic != null;
  const follows: [Follow, string][] = [["off", "Free"], ["ambulance", "Ambulance"], ["ghost", "Ghost"], ["both", "Both"]];
  return (
    <div className="toolbar" role="toolbar" aria-label="Map controls">
      <Toggle label="Ghost" checked={s.showGhost} onChange={(v) => s.set({ showGhost: v })} disabled={!reference} title={reference ? "" : "No comparison run"} />
      <span className="seg" role="group" aria-label="Follow"><span className="seg-label">Follow</span>
        {follows.map(([value, text]) => (
          <button
            key={value}
            className={s.follow === value ? "active" : ""}
            disabled={value !== "off" && !hasTrack}
            onClick={() => {
              s.set({ follow: value });
              if (value !== "off") s.requestView({ kind: value === "ghost" ? "ghost" : "ambulance" });
            }}
          >
            {text}
          </button>
        ))}
      </span>
      <Toggle label="Preempted only" checked={s.onlyPreempted} onChange={(v) => s.set({ onlyPreempted: v })} disabled={!hasTrack} title={hasTrack ? "" : NOT_RECORDED} />
      <Toggle label="Traffic" checked={s.showTraffic && hasTraffic} onChange={(v) => s.set({ showTraffic: v })} disabled={!hasTraffic} title={hasTraffic ? "" : "Background traffic not recorded for this run"} />
      <label className="sel inline">
        <span>Heat</span>
        <select value={s.heat} disabled={!hasTrack} onChange={(e) => s.set({ heat: e.target.value as Heat })}>
          <option value="off">Off</option>
          <option value="halting">Queues (halted)</option>
          <option value="vehicles">Vehicles</option>
          <option value="speed">Mean speed</option>
        </select>
      </label>
      <Toggle label="Labels" checked={s.showLabels} onChange={(v) => s.set({ showLabels: v })} />
      <Toggle label="Routes" checked={s.showRoutes} onChange={(v) => s.set({ showRoutes: v })} />
      <span className="seg" role="group" aria-label="Layout">
        <button className={s.layout === "overlay" ? "active" : ""} onClick={() => s.set({ layout: "overlay" })}>
          Overlay
        </button>
        <button className={s.layout === "split" ? "active" : ""} disabled={!reference} onClick={() => s.set({ layout: "split" })} title={reference ? "Two maps side by side" : "No comparison run"}>
          Split
        </button>
      </span>
      <span className="seg" role="group" aria-label="View">
        <button onClick={() => s.requestView({ kind: "zoom", factor: 1.4 })} title="Zoom in (+)">＋</button>
        <button onClick={() => s.requestView({ kind: "zoom", factor: 1 / 1.4 })} title="Zoom out (−)">－</button>
        <button onClick={() => s.requestView({ kind: "fit" })} title="Reset view">Reset</button>
        <button disabled={!hasTrack} onClick={() => s.requestView({ kind: "route" })}>Fit route</button>
        <button disabled={!hasTrack} onClick={() => s.requestView({ kind: "ambulance" })}>Centre</button>
        <button disabled={!reference?.playback} onClick={() => s.requestView({ kind: "ghost" })}>Ghost</button>
        <button onClick={() => s.requestView({ kind: "destination" })}>Hospital</button>
      </span>
      <span className="seg" role="group" aria-label="Panels">
        <button className={panels.left ? "active" : ""} onClick={() => setPanels({ ...panels, left: !panels.left })} title="Left panel">◧</button>
        <button className={panels.bottom ? "active" : ""} onClick={() => setPanels({ ...panels, bottom: !panels.bottom })} title="Timeline and charts">▭</button>
        <button className={panels.right ? "active" : ""} onClick={() => setPanels({ ...panels, right: !panels.right })} title="Right panel">◨</button>
      </span>
    </div>
  );
}

function MapLegend({ heat }: { heat: Heat }) {
  return (
    <div className="legend" aria-label="Legend">
      <div>
        {(["green", "yellow", "red"] as const).map((lamp) => (
          <span key={lamp}>
            <i style={{ background: LAMP_COLOR[lamp] }} /> {lamp}
          </span>
        ))}
      </div>
      <div>
        <span><i className="ring" style={{ borderColor: COLORS.clearing }} /> clearing</span>
        <span><i className="ring" style={{ borderColor: COLORS.preempt }} /> preempted</span>
        <span><i className="ring" style={{ borderColor: COLORS.recovery }} /> recovery</span>
      </div>
      <div>
        <span><i className="line" style={{ background: COLORS.routeNow }} /> route</span>
        <span><i className="line dashed" style={{ borderColor: COLORS.routeOld }} /> replaced route</span>
        <span><i className="line dashed" style={{ borderColor: COLORS.routeRef }} /> ghost route</span>
      </div>
      {heat !== "off" && <div className="muted">Heat: {HEAT_LEGEND[heat]} · recorded every 5 s</div>}
    </div>
  );
}

/** The most recent major event, for 3 s after it happens. */
function EventToast({ run }: { run: RunInfo }) {
  const t = useClockTime(4);
  const pb = run.playback;
  const recent = pb ? [...pb.majorEvents].reverse().find((e) => e.t <= t && t - e.t < 3 && e.kind !== "dispatch") : null;
  if (!recent) return null;
  return (
    <div className="toast" role="status">
      <strong>{recent.kind === "preempt" ? "Preemption" : recent.kind === "reroute" ? "Reroute" : recent.kind === "arrival" ? "Arrival" : recent.kind}</strong>
      {recent.junction && <span className="tag">{recent.junction}</span>}
      <span className="muted">{recent.text}</span>
    </div>
  );
}

/** Demo mode: only what a projector audience needs. */
function DemoOverlay({ primary, reference, comparison }: { primary: RunInfo; reference: RunInfo | null; comparison: Comparison }) {
  const t = useClockTime(10);
  const pb = primary.playback;
  const saved = comparison.timeSaved;
  const held = pb ? pb.preemptions.filter((p) => t >= p.start && t < p.end).map((p) => `${p.junction} ${stageLabel(signalAt(pb, p.junction, t)?.control ?? "program", signalAt(pb, p.junction, t)?.state ?? "")}`) : [];
  return (
    <div className="demo-card">
      <div className="muted small">DEMO PLAYBACK · recorded experiment, not live</div>
      <div className="demo-title">{labelOf(primary)}</div>
      {reference && <div className="muted">vs OFF ghost · {labelOf(reference)}</div>}
      <div className={`saved big ${saved === null ? "none" : saved >= 0 ? "good" : "bad"}`}>
        <span className="label">{saved !== null && saved < 0 ? "TIME LOST" : "TIME SAVED"}</span>
        <strong>{saved === null ? NOT_RECORDED : `${Math.abs(saved).toFixed(1)} s`}</strong>
        {saved === null && <span className="muted small">{comparison.reason}</span>}
      </div>
      <div className="demo-row">
        <span>
          Signals now: {held.length > 0 ? held.join(" · ") : "normal"}
        </span>
      </div>
      <div className="demo-row muted">
        {primary.summary ? `${num(primary.summary.travelS, 1, "s")} travel time` : NOT_RECORDED}
      </div>
    </div>
  );
}

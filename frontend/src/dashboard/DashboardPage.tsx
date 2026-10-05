/**
 * /dashboard: a read-only page for a second screen or another PC on the network (no 3D, so it
 * runs anywhere). Live: the simulation, the ambulance, the OFF ghost and the safety log, as an
 * observer that never sends a command. Below: the batch experiment results and charts.
 */
import { useEffect, useState } from "react";

import { useSim, type ResultsMsg, type StateMsg } from "../simulation/state";
import { SimSocket, fetchResults, socketUrl, tabClientId } from "../simulation/websocket";
import { formatDistance, formatEta } from "./Hud";
import { ExperimentChart } from "./Results";

const RESULTS_REFRESH_MS = 30_000; // a finished batch shows up without reloading
const PREFERRED_SCALE = 1.5;

export function DashboardPage() {
  const connection = useSim((s) => s.connection);
  const msg = useSim((s) => s.curr?.msg);

  useEffect(() => {
    const sim = new SimSocket(socketUrl(), tabClientId());
    sim.connect();
    return () => sim.close();
  }, []);

  return (
    <div className="dashboard-page">
      <header className="dash-header">
        <div>
          <h1>EmergencyFlow AI</h1>
          <div className="muted">
            Simulation testbed for emergency-vehicle signal priority · rule-based · no real signals are controlled
          </div>
        </div>
        <span className={`pill ${connection}`}>{connection === "open" ? "live" : "reconnecting"}</span>
      </header>
      {msg ? <Live msg={msg} /> : <div className="muted">Waiting for the simulation...</div>}
      <ResultsSection />
    </div>
  );
}

function Tile({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="dash-tile">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "good" | "bad" }) {
  return (
    <div className="dash-stat">
      <span className="muted">{label}</span>
      <strong className={tone ?? ""}>{value}</strong>
    </div>
  );
}

function Live({ msg }: { msg: StateMsg }) {
  const amb = msg.ambulance;
  const vehicle = msg.vehicles.find((v) => v.id === amb.id);
  const route = msg.route;
  const ghost = msg.ghost;
  const safe = msg.safety.violations + msg.safety.collisions === 0;
  return (
    <div className="dash-grid">
      <Tile title="Simulation">
        <Stat label="time" value={`${msg.t.toFixed(0)} s`} />
        <Stat label="signal mode" value={msg.mode} />
        <Stat label="vehicles" value={msg.vehicles.length} />
        <Stat label="accidents" value={msg.incidents.length} tone={msg.incidents.length ? "bad" : undefined} />
      </Tile>
      <Tile title="Ambulance">
        <Stat label="status" value={amb.status} />
        <Stat label="speed" value={vehicle ? `${(vehicle.speed * 3.6).toFixed(0)} km/h` : "-"} />
        <Stat label="mission time" value={amb.missionTime != null ? `${amb.missionTime.toFixed(1)} s` : "-"} />
        <Stat label="ETA" value={route ? `${formatEta(route.eta)} · ${formatDistance(route.distance)}` : "-"} />
        {route?.compromised && <div className="dash-alert">Route compromised: accident on {route.compromisedBy}</div>}
      </Tile>
      <Tile title="OFF ghost (same traffic, normal signals)">
        {!ghost && <div className="muted">Starts with the first dispatch after a reset.</div>}
        {ghost?.phase === "unavailable" && <div className="muted">{ghost.reason}</div>}
        {ghost && ghost.phase !== "unavailable" && (
          <>
            <Stat label="ghost" value={ghost.phase === "arrived" ? `arrived in ${ghost.missionTime?.toFixed(1)} s` : "on its way"} />
            <Stat
              label="time saved (measured)"
              value={msg.metrics.timeSaved != null ? `${msg.metrics.timeSaved.toFixed(1)} s` : "when both arrive"}
              tone={msg.metrics.timeSaved != null ? (msg.metrics.timeSaved >= 0 ? "good" : "bad") : undefined}
            />
          </>
        )}
      </Tile>
      <Tile title="Safety">
        <Stat label="violations (independent monitor)" value={msg.safety.violations} tone={safe ? "good" : "bad"} />
        <Stat label="collisions (SUMO)" value={msg.safety.collisions} tone={safe ? "good" : "bad"} />
        <Stat label="signals preempted" value={msg.metrics.signalsPreempted} />
        <Stat label="queues cleared ahead" value={msg.metrics.queueCleared ?? "-"} />
      </Tile>
      <section className="dash-tile wide">
        <h2>Safety controller log</h2>
        <ol className="log">
          {[...msg.safety.events].reverse().map((e) => (
            <li key={`${e.t}-${e.junction}-${e.action}`} className={e.accepted ? "" : "rejected"}>
              <span className="muted">{e.t.toFixed(1)}</span> {e.junction} {e.action}: {e.reason}
            </li>
          ))}
          {msg.safety.events.length === 0 && <li className="muted">no decisions yet</li>}
        </ol>
      </section>
    </div>
  );
}

function ResultsSection() {
  const [results, setResults] = useState<ResultsMsg | null>(null);
  const [scale, setScale] = useState<number | null>(null);
  useEffect(() => {
    const load = () => fetchResults().then(setResults).catch(() => undefined);
    load();
    const timer = window.setInterval(load, RESULTS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  if (!results) return null;
  if (!results.available) {
    return (
      <div className="dash-tile wide muted">
        Batch experiment results: {results.note}. Run <code>python -m scripts.run_experiments</code> in backend\.
      </div>
    );
  }
  const experiments = results.experiments;
  const chosen = scale ?? (experiments.some((e) => e.scale === PREFERRED_SCALE) ? PREFERRED_SCALE : experiments[0]?.scale);
  const current = experiments.find((e) => e.scale === chosen);
  return (
    <section className="dash-results">
      <h2>Batch experiments (autopilot runs, paired seeds)</h2>
      <div className="hud-row segmented" role="group" aria-label="Demand">
        <span className="label">Demand</span>
        {experiments.map((e) => (
          <button key={e.scale} className={e.scale === chosen ? "active" : ""} onClick={() => setScale(e.scale)}>
            x{e.scale}
          </button>
        ))}
      </div>
      {current && <ExperimentChart experiment={current} baseline={results.baseline} />}
      <div className="muted small">{results.note}</div>
      {results.charts.length > 0 && (
        <div className="dash-charts">
          {results.charts.map((name) => (
            <figure key={name}>
              <img src={`/api/charts/${name}`} alt={name} loading="lazy" />
              <figcaption className="muted small">{name}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}

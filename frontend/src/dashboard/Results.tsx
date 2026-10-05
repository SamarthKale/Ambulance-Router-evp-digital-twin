/**
 * In-app comparison chart (demo step 6): the batch experiment results from GET /api/results
 * (autopilot runs, paired seeds), plus this drive's measured time saved against its OFF ghost.
 */
import { useEffect, useState } from "react";

import { useSim, type ResultsMsg } from "../simulation/state";
import { fetchResults } from "../simulation/websocket";
import { formatPaired, SIGNAL_COLORS, travelBars } from "./resultsChart";

const WIDTH = 560;
const ROW = 26;
const LABEL_W = 150;
const PREFERRED_SCALE = 1.5; // the demo's heavy-traffic demand

export function Results({ onClose }: { onClose: () => void }) {
  const [results, setResults] = useState<ResultsMsg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState<number | null>(null);
  const timeSaved = useSim((s) => s.curr?.msg.metrics.timeSaved ?? null);
  const ghostTime = useSim((s) => s.curr?.msg.ghost?.missionTime ?? null);

  useEffect(() => {
    fetchResults()
      .then(setResults)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const experiments = results?.experiments ?? [];
  const preferred = experiments.findIndex((e) => e.scale === PREFERRED_SCALE);
  const current = experiments[index ?? (preferred >= 0 ? preferred : 0)];

  return (
    <div className="results-panel" role="dialog" aria-label="Experiment results">
      <header className="hud-row">
        <strong>Comparison: batch experiments</strong>
        <button className="small-button" onClick={onClose}>
          Close (R)
        </button>
      </header>

      {timeSaved !== null && (
        <div className="this-drive">
          This drive: <strong>{timeSaved >= 0 ? "saved" : "lost"} {Math.abs(timeSaved).toFixed(1)} s</strong> against
          its OFF ghost ({ghostTime?.toFixed(1)} s), measured on the same traffic.
        </div>
      )}

      {error && <div className="reply bad">Could not load results: {error}</div>}
      {results && !results.available && (
        <div className="muted">
          No experiment results yet ({results.note}). Run <code>python -m scripts.run_experiments</code> in backend\.
        </div>
      )}

      {experiments.length > 1 && (
        <div className="hud-row segmented" role="group" aria-label="Demand">
          <span className="label">Demand</span>
          {experiments.map((e, i) => (
            <button key={`${e.scenario}-${e.scale}`} className={e === current ? "active" : ""} onClick={() => setIndex(i)}>
              x{e.scale}
            </button>
          ))}
        </div>
      )}

      {current && <ExperimentChart experiment={current} baseline={results?.baseline ?? ""} />}
      {results?.available && <div className="muted small">{results.note}</div>}
    </div>
  );
}

function ExperimentChart({
  experiment,
  baseline,
}: {
  experiment: ResultsMsg["experiments"][number];
  baseline: string;
}) {
  const { bars, max } = travelBars(experiment.arms);
  const plotW = WIDTH - LABEL_W - 16;
  const x = (v: number) => LABEL_W + (v / max) * plotW;
  const height = bars.length * ROW + 28;
  const ticks = [0, max / 2, max];
  const byArm = new Map(experiment.arms.map((a) => [a.arm, a]));
  const safety = experiment.arms.reduce(
    (t, a) => ({ violations: t.violations + a.safety.violations, collisions: t.collisions + a.safety.collisions }),
    { violations: 0, collisions: 0 },
  );
  return (
    <>
      <div className="muted small">
        {experiment.scenario} · demand x{experiment.scale} · {experiment.seeds.length} paired seeds ·{" "}
        {experiment.signalProgram === "tuned" ? "signals tuned for the demand" : "the network's signals"} (cycle{" "}
        {experiment.cycleS?.toFixed(0)} s) · {experiment.pairingOk ? "identical traffic per seed" : "PAIRING CHECK FAILED"}
      </div>
      <svg width={WIDTH} height={height} className="results-chart" role="img" aria-label="Mean ambulance travel time per arm">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={0} y2={height - 18} stroke="#374151" />
            <text x={x(t)} y={height - 4} textAnchor="middle" className="axis">
              {t} s
            </text>
          </g>
        ))}
        {bars.map((b, i) => {
          const y = i * ROW + 4;
          return (
            <g key={b.arm}>
              <text x={LABEL_W - 8} y={y + 14} textAnchor="end" className="bar-label">
                {b.label}
              </text>
              <rect
                x={x(0)}
                y={y}
                width={x(b.mean) - x(0)}
                height={ROW - 8}
                fill={b.color}
                fillOpacity={b.dashed ? 0.35 : 0.85}
                stroke={b.color}
                strokeDasharray={b.dashed ? "4 3" : undefined}
              />
              <line x1={x(b.low)} x2={x(b.high)} y1={y + (ROW - 8) / 2} y2={y + (ROW - 8) / 2} stroke="#f9fafb" />
              <text x={x(b.high) + 6} y={y + 14} className="bar-value">
                {b.mean.toFixed(0)} s
              </text>
            </g>
          );
        })}
      </svg>
      <table className="results-table">
        <thead>
          <tr>
            <th>arm</th>
            <th>travel vs baseline (95 % CI)</th>
            <th>background delay vs baseline</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((b) => {
            const arm = byArm.get(b.arm)!;
            return (
              <tr key={b.arm}>
                <td>
                  <span className="dot" style={{ background: SIGNAL_COLORS[arm.signals] }} /> {b.label}
                </td>
                <td>{b.arm === baseline ? "baseline" : formatPaired(arm.travelVsBaseline, "s")}</td>
                <td>{b.arm === baseline ? "" : formatPaired(arm.bgDelayVsBaseline, "veh·s")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="muted small">
        Safety over all runs: {safety.violations} violations (independent monitor), {safety.collisions} collisions
        (SUMO). Dashed bars: static routing.
      </div>
    </>
  );
}

/** Heads-up display. Presentational: reads the store, raises callbacks. */
import { useShallow } from "zustand/react/shallow";

import { CONTROL_COLORS, signalColor } from "../components/vehicleStyles";
import { ambulanceOf, median, useSim, type NetworkMsg, type SignalMode } from "../simulation/state";

interface HudProps {
  network: NetworkMsg | null;
  onDispatch: () => void;
  onReset: () => void;
  onMode: (mode: SignalMode) => void;
  onRelease: () => void;
}

const ROLE_TEXT = {
  driver: "You are driving",
  observer: "Observer: another screen is driving",
  free: "Dispatch to take control",
} as const;

const TURN_LABEL = { left: "LEFT", straight: "STRAIGHT", right: "RIGHT", uturn: "U-TURN" } as const;
const MODES: { mode: SignalMode; title: string; ready: boolean }[] = [
  { mode: "OFF", title: "Normal signals", ready: true },
  { mode: "BASIC", title: "Rule-based preemption", ready: true },
  { mode: "COORD", title: "Coordinated preemption (Sprint 7)", ready: false },
];
const LOG_LINES = 5;

export function Hud({ network, onDispatch, onReset, onMode, onRelease }: HudProps) {
  const { connection, curr, keys, lastReply, latencyMs, follow, fps, drawCalls, role, toggleFollow } =
    useSim(
      useShallow((s) => ({
        connection: s.connection,
        curr: s.curr,
        keys: s.keys,
        lastReply: s.lastReply,
        latencyMs: s.latencyMs,
        follow: s.follow,
        fps: s.fps,
        drawCalls: s.drawCalls,
        role: s.role,
        toggleFollow: s.toggleFollow,
      })),
    );
  const observer = role === "observer";
  const msg = curr?.msg;
  const amb = msg?.ambulance;
  const vehicle = ambulanceOf(msg);
  const latency = median(latencyMs);
  const safety = msg?.safety;
  const laneName =
    vehicle && !vehicle.edge.startsWith(":")
      ? vehicle.lane === 0
        ? `curb lane (${network?.lefthand ? "left" : "right"})`
        : "inner lane"
      : "in junction";
  const nextControl = msg?.signals.find((s) => s.id === amb?.nextSignal?.junction)?.control;

  return (
    <div className="hud">
      <header className="hud-row">
        <strong>EmergencyFlow AI</strong>
        <span className={`pill ${connection}`}>{connection === "open" ? "open" : "reconnecting"}</span>
      </header>
      <div className="hud-row muted">
        t = {msg ? msg.t.toFixed(1) : "-"} s · {msg?.vehicles.length ?? 0} vehicles · {fps} FPS ·{" "}
        {drawCalls} draws
      </div>
      <div className={`hud-row role ${role}`}>
        {ROLE_TEXT[role]}
        {role === "driver" && (
          <button className="small-button" onClick={onRelease}>
            Release control
          </button>
        )}
      </div>

      <div className="hud-row modes" role="group" aria-label="Signal mode">
        {MODES.map(({ mode, title, ready }) => (
          <button
            key={mode}
            title={title}
            disabled={!ready || observer}
            className={msg?.mode === mode ? "active" : ""}
            onClick={() => onMode(mode)}
          >
            {mode}
          </button>
        ))}
      </div>

      <section className="card">
        <div className="hud-row">
          <span className="label">Ambulance</span>
          <span className={`status ${amb?.status ?? "none"}`}>{amb?.status ?? "none"}</span>
          {amb?.missionTime != null && <span className="muted">{amb.missionTime.toFixed(0)} s</span>}
        </div>
        <div className="speed">
          {vehicle ? (vehicle.speed * 3.6).toFixed(0) : "-"} <small>km/h</small>
        </div>
        <div className="hud-row">
          <span className={`key ${keys.throttle ? "on throttle" : ""}`}>W throttle</span>
          <span className={`key ${keys.brake ? "on brake" : ""}`}>S brake</span>
        </div>
        {amb?.nextSignal && (
          <div className="hud-row">
            <span className="dot" style={{ background: signalColor(amb.nextSignal.state) }} />
            signal {amb.nextSignal.junction} in {amb.nextSignal.distance.toFixed(0)} m
            {nextControl && nextControl !== "program" && (
              <span className="tag" style={{ borderColor: CONTROL_COLORS[nextControl] }}>
                {nextControl}
              </span>
            )}
          </div>
        )}
        {amb?.plannedTurn && (
          <div className="hud-row">
            next: <strong>{TURN_LABEL[amb.plannedTurn.turn]}</strong> at {amb.plannedTurn.junction}
            {amb.queuedTurn && <span className="muted"> · then {amb.queuedTurn}</span>}
          </div>
        )}
        {vehicle && <div className="hud-row muted">{laneName}</div>}
      </section>

      {lastReply && (lastReply.type === "error" || !lastReply.ok || lastReply.reason) && (
        <div className={`reply ${lastReply.type === "ack" && lastReply.ok ? "ok" : "bad"}`}>
          {lastReply.reason}
        </div>
      )}

      <section className="card">
        <div className="hud-row">
          <span className="label">Safety</span>
          <span className={`status ${safety && safety.violations + safety.collisions > 0 ? "alarm" : "driving"}`}>
            {safety?.violations ?? 0} violations · {safety?.collisions ?? 0} collisions
          </span>
        </div>
        <div className="hud-row muted">signals preempted: {msg?.metrics.signalsPreempted ?? 0}</div>
        <ol className="log">
          {(safety?.events ?? [])
            .slice(-LOG_LINES)
            .reverse()
            .map((e) => (
              <li key={`${e.t}-${e.junction}-${e.action}`} className={e.accepted ? "" : "rejected"}>
                <span className="muted">{e.t.toFixed(1)}</span> {e.junction} {e.action}: {e.reason}
              </li>
            ))}
        </ol>
      </section>

      <div className="hud-row">
        <button onClick={onDispatch} disabled={observer}>
          Dispatch ambulance
        </button>
        <button onClick={onReset} disabled={observer}>
          Reset
        </button>
        <button onClick={toggleFollow} className={follow ? "active" : ""}>
          Follow (F)
        </button>
      </div>
      <div className="muted small">
        W/S speed · A/D turn at next junction · Q/E lane · input→response{" "}
        {latency === null ? "-" : `${latency.toFixed(0)} ms (n=${latencyMs.length})`}
      </div>
    </div>
  );
}

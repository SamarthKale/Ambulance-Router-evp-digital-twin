/** Heads-up display. Presentational: reads the store, raises callbacks. */
import { useShallow } from "zustand/react/shallow";

import { signalColor } from "../components/vehicleStyles";
import { ambulanceOf, median, useSim, type NetworkMsg } from "../simulation/state";

interface HudProps {
  network: NetworkMsg | null;
  onDispatch: () => void;
  onReset: () => void;
}

const TURN_LABEL = { left: "LEFT", straight: "STRAIGHT", right: "RIGHT", uturn: "U-TURN" } as const;

export function Hud({ network, onDispatch, onReset }: HudProps) {
  const { connection, curr, keys, lastReply, latencyMs, follow, fps, toggleFollow } = useSim(
    useShallow((s) => ({
      connection: s.connection,
      curr: s.curr,
      keys: s.keys,
      lastReply: s.lastReply,
      latencyMs: s.latencyMs,
      follow: s.follow,
      fps: s.fps,
      toggleFollow: s.toggleFollow,
    })),
  );
  const msg = curr?.msg;
  const amb = msg?.ambulance;
  const vehicle = ambulanceOf(msg);
  const latency = median(latencyMs);
  const laneName =
    vehicle && !vehicle.edge.startsWith(":")
      ? vehicle.lane === 0
        ? `curb lane (${network?.lefthand ? "left" : "right"})`
        : "inner lane"
      : "in junction";

  return (
    <div className="hud">
      <header className="hud-row">
        <strong>EmergencyFlow AI</strong>
        <span className={`pill ${connection}`}>{connection}</span>
        <span className="pill">mode {msg?.mode ?? "-"}</span>
      </header>
      <div className="hud-row muted">
        t = {msg ? msg.t.toFixed(1) : "-"} s · {msg?.vehicles.length ?? 0} vehicles · {fps} FPS
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

      <div className="hud-row">
        <button onClick={onDispatch}>Dispatch ambulance</button>
        <button onClick={onReset}>Reset</button>
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

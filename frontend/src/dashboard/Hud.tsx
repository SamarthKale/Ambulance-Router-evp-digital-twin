/**
 * Heads-up display. Presentational: reads the store, raises callbacks.
 * Two panels (driving on the left, safety on the right) leave the centre of the screen to
 * the 3D view; the camera centres the scene between them (dashboard/layout.ts).
 */
import { useShallow } from "zustand/react/shallow";

import { useAssetStore } from "../assets/loader";
import { ASSET_KEYS } from "../assets/manifest";
import { useSkyStore } from "../components/Sky";
import { CONTROL_COLORS, signalColor } from "../components/vehicleStyles";
import { TURN_ARROW } from "../components/RouteOverlay";
import {
  ambulanceOf,
  median,
  useSim,
  type NetworkMsg,
  type RouteMsg,
  type SignalMode,
  type TurnKind,
  type ViewMode,
} from "../simulation/state";
import { HUD_LEFT_PX, HUD_MARGIN_PX, HUD_RIGHT_PX } from "./layout";

interface HudProps {
  network: NetworkMsg | null;
  onDispatch: () => void;
  onReset: () => void;
  onMode: (mode: SignalMode) => void;
  onRelease: () => void;
  onAccident: () => void;
  onClearAccidents: () => void;
}

const ROLE_TEXT = {
  driver: "You are driving",
  observer: "Observer: another screen is driving",
  free: "Dispatch to take control",
} as const;

const TURN_LABEL = { left: "LEFT", straight: "STRAIGHT", right: "RIGHT", uturn: "U-TURN" } as const;
const MODES: { mode: SignalMode; title: string; ready: boolean }[] = [
  { mode: "OFF", title: "Normal fixed-time signals", ready: true },
  { mode: "BASIC", title: "Rule-based preemption: the next signal turns green 15 s ahead", ready: true },
  {
    mode: "COORD",
    title:
      "Coordinated, rule-based: preempts early enough for the queue in front to clear, " +
      "and prepares the next junctions on the suggested route",
    ready: true,
  },
];
const VIEWS: { view: ViewMode; label: string; title: string }[] = [
  { view: "chase", label: "Chase", title: "Behind the ambulance (city overview while none is out)" },
  { view: "orbit", label: "Orbit", title: "Free camera: drag to rotate, right-drag to pan, wheel to zoom" },
  { view: "top", label: "Map", title: "2D map with per-link signal states (F: follow)" },
];
const LOG_LINES = 6;

const panelStyle = {
  left: { width: HUD_LEFT_PX, left: HUD_MARGIN_PX },
  right: { width: HUD_RIGHT_PX, right: HUD_MARGIN_PX },
};

export function Hud({ network, onDispatch, onReset, onMode, onRelease, onAccident, onClearAccidents }: HudProps) {
  const s = useSim(
    useShallow((st) => ({
      connection: st.connection,
      curr: st.curr,
      keys: st.keys,
      lastReply: st.lastReply,
      latencyMs: st.latencyMs,
      follow: st.follow,
      view: st.view,
      fps: st.fps,
      drawCalls: st.drawCalls,
      triangles: st.triangles,
      role: st.role,
      toggleFollow: st.toggleFollow,
      setView: st.setView,
    })),
  );
  const observer = s.role === "observer";
  const msg = s.curr?.msg;
  const amb = msg?.ambulance;
  const vehicle = ambulanceOf(msg);
  const latency = median(s.latencyMs);
  const laneName =
    vehicle && !vehicle.edge.startsWith(":")
      ? vehicle.lane === 0
        ? `curb lane (${network?.lefthand ? "left" : "right"})`
        : "inner lane"
      : "in junction";
  const nextControl = msg?.signals.find((sig) => sig.id === amb?.nextSignal?.junction)?.control;

  return (
    <>
      <div className="hud hud-left" style={panelStyle.left}>
        <header className="hud-row">
          <strong>EmergencyFlow AI</strong>
          <span className={`pill ${s.connection}`}>{s.connection === "open" ? "live" : "reconnecting"}</span>
        </header>
        <div className="hud-row muted small">
          t = {msg ? msg.t.toFixed(1) : "-"} s · {msg?.vehicles.length ?? 0} vehicles · {s.fps} FPS · {s.drawCalls} draws ·{" "}
          {(s.triangles / 1e6).toFixed(2)} M tris
        </div>
        <div className={`hud-row role ${s.role}`}>
          {ROLE_TEXT[s.role]}
          {s.role === "driver" && (
            <button className="small-button" onClick={onRelease}>
              Release control
            </button>
          )}
        </div>

        <div className="hud-row segmented" role="group" aria-label="Signal mode">
          <span className="label">Signals</span>
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
        <div className="hud-row segmented" role="group" aria-label="Camera">
          <span className="label">View (C)</span>
          {VIEWS.map(({ view, label, title }) => (
            <button key={view} title={title} className={s.view === view ? "active" : ""} onClick={() => s.setView(view)}>
              {label}
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
            <span className={`key ${s.keys.throttle ? "on throttle" : ""}`}>W throttle</span>
            <span className={`key ${s.keys.brake ? "on brake" : ""}`}>S brake</span>
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
          {msg?.route && <RouteCard route={msg.route} />}
        </section>

        {s.lastReply && (s.lastReply.type === "error" || !s.lastReply.ok || s.lastReply.reason) && (
          <div className={`reply ${s.lastReply.type === "ack" && s.lastReply.ok ? "ok" : "bad"}`}>{s.lastReply.reason}</div>
        )}

        <div className="hud-row">
          <button className="primary" onClick={onDispatch} disabled={observer}>
            Dispatch ambulance
          </button>
          <button onClick={onReset} disabled={observer}>
            Reset
          </button>
          {s.view === "top" && (
            <button onClick={s.toggleFollow} className={s.follow ? "active" : ""}>
              Follow (F)
            </button>
          )}
        </div>
        <div className="hud-row">
          <button
            className="danger"
            onClick={onAccident}
            disabled={observer || !msg?.route}
            title="Block one lane of the next road on the suggested route with an accident"
          >
            Create accident
          </button>
          {(msg?.incidents.length ?? 0) > 0 && (
            <button onClick={onClearAccidents} disabled={observer}>
              Clear accidents ({msg?.incidents.length})
            </button>
          )}
        </div>
        <div className="muted small">
          W/S speed · A/D turn at next junction · Q/E lane · input→response{" "}
          {latency === null ? "-" : `${latency.toFixed(0)} ms (n=${s.latencyMs.length})`}
        </div>
      </div>

      <div className="hud hud-right" style={panelStyle.right}>
        <SafetyCard />
        <AssetStatus />
      </div>
    </>
  );
}

const TURN_KEY: Partial<Record<TurnKind, string>> = { left: "A", right: "D" };

export function formatEta(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatChange(seconds: number): string {
  const s = Math.round(seconds);
  return s === 0 ? "unchanged" : `${s > 0 ? "+" : "−"}${Math.abs(s)} s`;
}

export function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

/** Suggested route: advisory only, the driver decides (CLAUDE.md section 2.6). */
function RouteCard({ route }: { route: RouteMsg }) {
  const next = route.turns[0];
  const key = next ? TURN_KEY[next.turn] : undefined;
  return (
    <div className={`route-card ${route.follows ? "" : "off-plan"}`}>
      {route.compromised && (
        <div className="compromised" role="alert">
          <strong>Route compromised</strong>: accident on {route.compromisedBy}
          <div className="small">
            {route.blockedAhead
              ? "no faster way round: the route still passes it"
              : `re-routed${route.etaChange != null ? ` · ETA ${formatChange(route.etaChange)}` : ""}`}
          </div>
        </div>
      )}
      {!route.compromised && route.blockedAhead && (
        <div className="hud-row">
          <span className="tag warn">route passes an accident</span>
        </div>
      )}
      <div className="hud-row">
        <span className="eta">ETA {formatEta(route.eta)}</span>
        <span className="muted">{formatDistance(route.distance)} to the hospital</span>
      </div>
      {next && (
        <div className="hud-row">
          suggested:{" "}
          <strong>
            {TURN_ARROW[next.turn]} {next.turn.toUpperCase()}
          </strong>{" "}
          at {next.junction}
          {!route.follows && (
            <span className="tag hint">{key ? `press ${key}` : "your plan differs"}</span>
          )}
        </div>
      )}
      <div className="muted small">
        {route.routing} route · drive {route.drive.toFixed(0)} s · queues {route.queue.toFixed(0)} s · signals{" "}
        {route.signal.toFixed(0)} s
      </div>
    </div>
  );
}

function SafetyCard() {
  const msg = useSim((st) => st.curr?.msg);
  const safety = msg?.safety;
  return (
    <section className="card">
      <div className="hud-row">
        <span className="label">Safety</span>
        <span className={`status ${safety && safety.violations + safety.collisions > 0 ? "alarm" : "driving"}`}>
          {safety?.violations ?? 0} violations · {safety?.collisions ?? 0} collisions
        </span>
      </div>
      <div className="hud-row muted">
        signals preempted: {msg?.metrics.signalsPreempted ?? 0}
        {msg?.metrics.queueCleared != null && <> · queues cleared ahead: {msg.metrics.queueCleared}</>}
      </div>
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
      <div className="muted small">Simulation testbed: no real signals are controlled.</div>
    </section>
  );
}

function AssetStatus() {
  const states = useAssetStore((st) => st.states);
  const sky = useSkyStore((st) => st.status);
  const values = ASSET_KEYS.map((k) => states[k]?.status);
  const loaded = values.filter((v) => v === "loaded").length;
  const failed = values.filter((v) => v === "error").length;
  const pending = values.filter((v) => v === "loading" || v === "waiting").length;
  return (
    <div className="muted small asset-status">
      models {loaded} loaded{pending ? ` · ${pending} loading` : ""}
      {failed ? ` · ${failed} placeholder` : ""} · sky {sky === "ready" ? "HDRI" : sky === "error" ? "plain" : sky}
    </div>
  );
}

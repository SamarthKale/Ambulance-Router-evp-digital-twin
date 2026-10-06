/**
 * The replay map: SUMO's real road geometry on a 2D canvas, with the recorded ambulance, the
 * recorded reference run (the OFF ghost), the recorded signal states, routes, background traffic
 * and per-road queue counts at the playback time. It redraws when the clock, the view or an
 * option changes, never on a timer of its own, and it never invents a position.
 */
import { useEffect, useRef } from "react";

import {
  approach,
  fitCamera,
  frameTargets,
  panBy,
  toWorld,
  zoomAt,
  type Camera,
} from "./camera";
import { clock } from "./clock";
import type { RunInfo } from "./compare";
import {
  lineLength,
  nearestEdge,
  nearestJunction,
  pointBeforeEnd,
  routePolyline,
  type MapGeometry,
} from "./mapGeometry";
import { COLORS, heatColor, LAMP_COLOR } from "./mapStyle";
import {
  edgeSampleIndex,
  lampOf,
  newTrafficFrame,
  poseAt,
  routeAt,
  signalAt,
  signalVisible,
  trafficAt,
  type Playback,
  type Pose,
} from "./playback";
import { useReplay } from "./replayStore";

export const DESTINATION_BACK_M = 15; // the mission ends 15 m before the end of its road

interface Props {
  geometry: MapGeometry;
  focus: RunInfo;
  other: RunInfo | null; // the reference run drawn as a ghost (overlay layout)
  otherLabel: string;
}

const CAR_COLORS = ["#94a3b8", "#a8b3c4", "#8b9bb0", "#b4bfd0"];
const GHOST_FOLLOW_MIN_SCALE = 1.2;

function trailUpTo(pb: Playback, t: number): number {
  let lo = 0;
  let hi = pb.times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pb.times[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Column of each road in a run's per-road samples, cached per playback. */
const columnCache = new WeakMap<Playback, Map<string, number>>();
function edgeColumns(pb: Playback): Map<string, number> {
  let cols = columnCache.get(pb);
  if (!cols) {
    cols = new Map(pb.run.edges.ids.map((id, i) => [id, i]));
    columnCache.set(pb, cols);
  }
  return cols;
}

export function MapCanvas({ geometry, focus, other, otherLabel }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cam = useRef<Camera>(fitCamera(geometry.bounds, 800, 600));
  const size = useRef({ w: 800, h: 600, dpr: 1 });
  const frame = useRef(newTrafficFrame(4000));
  const typeIds = useRef(new Map<string, number>());
  const pending = useRef(0);
  const touched = useRef(false); // the user panned, zoomed or asked for a view: keep it on resize
  const lastDraw = useRef(performance.now());
  const latest = useRef({ geometry, focus, other, otherLabel });
  latest.current = { geometry, focus, other, otherLabel };

  const fit = (): Camera => fitCamera(latest.current.geometry.bounds, size.current.w, size.current.h);

  const draw = (): void => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastDraw.current) / 1000);
    lastDraw.current = now;
    const { geometry: geo, focus: run, other: ref, otherLabel: refLabel } = latest.current;
    const st = useReplay.getState();
    const { w, h, dpr } = size.current;
    const t = clock.t;
    const pb = run.playback;
    const refPb = ref?.playback ?? null;
    const pose = pb ? poseAt(pb, t) : null;
    const refPose = refPb && st.showGhost ? poseAt(refPb, t) : null;

    // ---- follow
    if (st.follow !== "off") {
      const targets: [number, number][] = [];
      if ((st.follow === "ambulance" || st.follow === "both") && pose) targets.push([pose.x, pose.y]);
      if ((st.follow === "ghost" || st.follow === "both") && refPose) targets.push([refPose.x, refPose.y]);
      if (targets.length === 0 && pose) targets.push([pose.x, pose.y]);
      if (targets.length > 0) {
        const target =
          targets.length > 1
            ? frameTargets(targets, w, h, fit().scale * 0.9)
            : { cx: targets[0][0], cy: targets[0][1], scale: cam.current.scale };
        cam.current = approach(cam.current, target, 1 - Math.exp(-dt * 7));
      }
    }
    const c = cam.current;
    const s = c.scale;
    const X = (x: number): number => (x - c.cx) * s + w / 2;
    const Y = (y: number): number => h / 2 - (y - c.cy) * s;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, 0, w, h);
    ctx.lineJoin = "round";
    ctx.lineCap = "butt";

    // ---- roads: an outline pass, then the surface
    const polyline = (line: readonly (readonly [number, number])[]): void => {
      ctx.beginPath();
      line.forEach((p, i) => (i === 0 ? ctx.moveTo(X(p[0]), Y(p[1])) : ctx.lineTo(X(p[0]), Y(p[1]))));
    };
    for (const pass of [0, 1] as const) {
      ctx.strokeStyle = pass === 0 ? COLORS.roadEdge : COLORS.road;
      for (const [edge, line] of geo.edgeLine) {
        ctx.lineWidth = (geo.edgeWidth.get(edge) ?? 6.4) * s + (pass === 0 ? 2.5 : 0);
        polyline(line);
        ctx.stroke();
      }
    }
    ctx.fillStyle = COLORS.junction;
    for (const j of geo.junctions) {
      if (j.shape.length < 3) continue;
      polyline(j.shape);
      ctx.closePath();
      ctx.fill();
    }

    // ---- heat (recorded per-road counts, every 5 s)
    if (pb && st.heat !== "off") {
      const sample = pb.run.edges.samples[edgeSampleIndex(pb, t)];
      const cols = edgeColumns(pb);
      if (sample) {
        for (const [edge, line] of geo.edgeLine) {
          const i = cols.get(edge);
          if (i === undefined) continue;
          const color = heatColor(st.heat, sample.halting[i], sample.vehicles[i], sample.speed[i]);
          if (!color) continue;
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.65;
          ctx.lineWidth = (geo.edgeWidth.get(edge) ?? 6.4) * s;
          polyline(line);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }
    if (st.selectedEdge) {
      const line = geo.edgeLine.get(st.selectedEdge);
      if (line) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        polyline(line);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // ---- routes: the recorded suggestion now, the one it replaced, and the reference's
    if (st.showRoutes) {
      const routeLine = (edges: readonly string[], color: string, width: number, dash: number[], alpha: number): void => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.globalAlpha = alpha;
        ctx.setLineDash(dash);
        polyline(routePolyline(geo, edges));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      };
      if (refPb && st.showGhost) {
        const r = routeAt(refPb, t).current;
        if (r) routeLine(r.edges, COLORS.routeRef, 2.5, [5, 5], 0.65);
      }
      if (pb) {
        const r = routeAt(pb, t);
        if (r.previous) routeLine(r.previous.edges, COLORS.routeOld, 3, [8, 6], 0.85);
        if (r.current) routeLine(r.current.edges, COLORS.routeNow, 4, [], 0.9);
      }
    }

    // ---- signals: the recorded state of every approach, the controller's stage per junction
    const signalIds = geo.junctions.filter((j) => j.signalised);
    for (const j of signalIds) {
      const sig = pb ? signalAt(pb, j.id, t) : null;
      if (!signalVisible(sig, st.onlyPreempted)) continue;
      const halo = sig?.control === "clearing" ? COLORS.clearing : sig?.control === "preempted" ? COLORS.preempt : sig?.control === "recovering" ? COLORS.recovery : null;
      if (halo) {
        ctx.strokeStyle = halo;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(X(j.cx), Y(j.cy), 17 * s, 0, Math.PI * 2);
        ctx.stroke();
      }
      for (const a of geo.approachesByJunction.get(j.id) ?? []) {
        const lamp = sig ? lampOf(sig.state, a.links) : null;
        const hw = a.width / 2;
        ctx.strokeStyle = lamp ? LAMP_COLOR[lamp] : "#64748b";
        ctx.lineWidth = Math.max(3, 1.5 * s);
        if (sig?.control === "preempted" && lamp === "green") {
          ctx.shadowColor = COLORS.preempt;
          ctx.shadowBlur = 14;
        }
        ctx.beginPath();
        ctx.moveTo(X(a.x - a.dy * hw), Y(a.y + a.dx * hw));
        ctx.lineTo(X(a.x + a.dy * hw), Y(a.y - a.dx * hw));
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }
    if (st.selectedSignal) {
      const j = geo.junctions.find((q) => q.id === st.selectedSignal);
      if (j) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(X(j.cx), Y(j.cy), 24 * s, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // ---- background traffic (recorded at 1 Hz, interpolated between samples)
    if (pb && st.showTraffic && pb.traffic) {
      const f = frame.current;
      const count = trafficAt(pb, t, f, (type) => {
        let id = typeIds.current.get(type);
        if (id === undefined) typeIds.current.set(type, (id = typeIds.current.size));
        return id;
      });
      for (let i = 0; i < count; i++) {
        ctx.fillStyle = CAR_COLORS[f.type[i] % CAR_COLORS.length];
        const px = X(f.x[i]);
        const py = Y(f.y[i]);
        if (s < 0.8) {
          ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
        } else {
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate((f.angle[i] * Math.PI) / 180);
          ctx.fillRect((-1.9 * s) / 2, (-4.5 * s) / 2, 1.9 * s, 4.5 * s);
          ctx.restore();
        }
      }
    }

    // ---- accidents, if any were recorded
    for (const inc of pb?.run.incidents ?? []) {
      if (t < inc.since) continue;
      const pulse = t - inc.since < 4 ? 1 + 0.5 * Math.sin(t * 10) : 1;
      ctx.fillStyle = COLORS.incident;
      ctx.beginPath();
      ctx.arc(X(inc.x), Y(inc.y), Math.max(6, 3 * s) * pulse, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- start and destination of the mission
    const markers: { text: string; at: [number, number] | null; color: string }[] = [];
    if (run.summary) {
      const origin = geo.edgeLine.get(run.summary.origin)?.[0] ?? null;
      const destLine = geo.edgeLine.get(run.summary.destination);
      markers.push({ text: "Start", at: origin, color: "#34d399" });
      markers.push({ text: "Hospital", at: destLine ? pointBeforeEnd(destLine, DESTINATION_BACK_M) : null, color: "#f87171" });
    }
    for (const m of markers) {
      if (!m.at) continue;
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.arc(X(m.at[0]), Y(m.at[1]), 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#0b1220";
      ctx.lineWidth = 2;
      ctx.stroke();
      if (st.showLabels) {
        ctx.fillStyle = COLORS.label;
        ctx.font = "600 11px system-ui, sans-serif";
        ctx.fillText(m.text, X(m.at[0]) + 9, Y(m.at[1]) + 4);
      }
    }

    // ---- trails and vehicles
    const drawTrail = (playback: Playback, color: string, alpha: number): void => {
      const last = trailUpTo(playback, t);
      if (last < 1) return;
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i <= last; i++) {
        const sample = playback.run.ambulance[i];
        if (i === 0) ctx.moveTo(X(sample[1]), Y(sample[2]));
        else ctx.lineTo(X(sample[1]), Y(sample[2]));
      }
      const live = poseAt(playback, t);
      if (live) ctx.lineTo(X(live.x), Y(live.y));
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    const drawAmbulance = (p: Pose, color: string, alpha: number, flash: boolean): void => {
      const length = Math.max(15, 6 * s);
      const width = Math.max(7, 2.4 * s);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(X(p.x), Y(p.y));
      ctx.rotate((p.angle * Math.PI) / 180);
      ctx.fillStyle = color;
      ctx.strokeStyle = "#0b1220";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(-width / 2, -length / 2, width, length, 2);
      ctx.fill();
      ctx.stroke();
      if (flash) {
        ctx.fillStyle = Math.floor(t * 4) % 2 === 0 ? "#ef4444" : "#3b82f6";
        ctx.fillRect(-width / 2 + 1, -length / 2 + length * 0.32, width - 2, length * 0.16);
      }
      ctx.restore();
    };
    if (refPb && refPose && st.showGhost) {
      drawTrail(refPb, COLORS.ghost, 0.35);
      drawAmbulance(refPose, COLORS.ghost, 0.5, false);
      ctx.fillStyle = COLORS.ghost;
      ctx.font = "600 11px system-ui, sans-serif";
      ctx.fillText(refLabel, X(refPose.x) + 12, Y(refPose.y) - 10);
    }
    if (pb && pose) {
      drawTrail(pb, COLORS.actual, 0.7);
      drawAmbulance(pose, "#f8fafc", 1, true);
      if (st.showLabels) {
        ctx.fillStyle = "#e0f2fe";
        ctx.font = "600 11px system-ui, sans-serif";
        ctx.fillText("Ambulance", X(pose.x) + 12, Y(pose.y) + 14);
      }
    }

    // ---- labels
    if (st.showLabels && s > 0.3) {
      ctx.fillStyle = COLORS.label;
      ctx.font = "600 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      for (const j of signalIds) {
        if (!signalVisible(pb ? signalAt(pb, j.id, t) : null, st.onlyPreempted)) continue;
        ctx.fillText(j.id, X(j.cx), Y(j.cy) + 4);
      }
      ctx.textAlign = "start";
    }

    // ---- scale bar
    const nice = [10, 20, 50, 100, 200, 500].find((m) => m * s >= 60) ?? 500;
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(14, h - 16);
    ctx.lineTo(14 + nice * s, h - 16);
    ctx.stroke();
    ctx.fillStyle = "#e2e8f0";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(`${nice} m`, 14, h - 22);

    // keep animating while the camera is still catching up with a followed vehicle
    if (st.follow !== "off" && (pose || refPose)) schedule();
  };

  const schedule = (): void => {
    if (pending.current) return;
    pending.current = requestAnimationFrame(() => {
      pending.current = 0;
      draw();
    });
  };

  // size and DPR
  useEffect(() => {
    const el = wrap.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const resize = (): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(50, el.clientWidth);
      const h = Math.max(50, el.clientHeight);
      size.current = { w, h, dpr };
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      if (!touched.current) cam.current = fit();
      schedule();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // redraw on every clock change and store change
  useEffect(() => {
    const offClock = clock.subscribe(schedule);
    const offStore = useReplay.subscribe(schedule);
    schedule();
    return () => {
      offClock();
      offStore();
      cancelAnimationFrame(pending.current);
      pending.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(schedule); // the props changed

  // view requests (fit, centre on ...)
  const nonce = useReplay((s) => s.viewNonce);
  useEffect(() => {
    const request = useReplay.getState().viewRequest;
    const { geometry: geo, focus: run, other: ref } = latest.current;
    const { w, h } = size.current;
    const t = clock.t;
    const center = (x: number, y: number, minScale: number): void => {
      cam.current = { cx: x, cy: y, scale: Math.max(cam.current.scale, minScale) };
    };
    touched.current = !!request && request.kind !== "fit";
    if (!request || request.kind === "fit") cam.current = fit();
    else if (request.kind === "zoom") {
      cam.current = zoomAt(cam.current, w, h, w / 2, h / 2, request.factor, fit());
    } else if (request.kind === "route") {
      const route = run.playback ? routeAt(run.playback, t).current : null;
      const line = route ? routePolyline(geo, route.edges) : [];
      cam.current = line.length > 0 ? frameTargets(line, w, h, fit().scale, 60) : fit();
    } else if (request.kind === "ambulance" || request.kind === "ghost") {
      const source = request.kind === "ambulance" ? run.playback : ref?.playback ?? null;
      const p = source ? poseAt(source, t) : null;
      if (p) center(p.x, p.y, GHOST_FOLLOW_MIN_SCALE);
    } else if (request.kind === "destination") {
      const line = run.summary ? geo.edgeLine.get(run.summary.destination) : undefined;
      const point = line ? pointBeforeEnd(line, DESTINATION_BACK_M) : null;
      if (point) center(point[0], point[1], 1);
    } else if (request.kind === "junction") {
      const j = geo.junctions.find((q) => q.id === request.id);
      if (j) center(j.cx, j.cy, 1.4);
    } else {
      const line = geo.edgeLine.get(request.id);
      if (line) {
        const mid = line[Math.floor(line.length / 2)];
        const half = lineLength(line) / 2;
        center(mid[0], mid[1], Math.min(2, Math.max(0.8, 180 / Math.max(half, 1))));
      }
    }
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  // pan, zoom, click
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    let drag: { x: number; y: number; moved: number } | null = null;
    const local = (e: PointerEvent | WheelEvent | MouseEvent): [number, number] => {
      const r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const [sx, sy] = local(e);
      const { w, h } = size.current;
      touched.current = true;
      cam.current = zoomAt(cam.current, w, h, sx, sy, Math.exp(-e.deltaY * 0.0015), fit());
      schedule();
    };
    const onDown = (e: PointerEvent): void => {
      cv.setPointerCapture(e.pointerId);
      const [x, y] = local(e);
      drag = { x, y, moved: 0 };
    };
    const onMove = (e: PointerEvent): void => {
      if (!drag) return;
      const [x, y] = local(e);
      const dx = x - drag.x;
      const dy = y - drag.y;
      drag = { x, y, moved: drag.moved + Math.abs(dx) + Math.abs(dy) };
      if (drag.moved > 4) {
        if (useReplay.getState().follow !== "off") useReplay.getState().set({ follow: "off" });
        touched.current = true;
        cam.current = panBy(cam.current, dx, dy);
        schedule();
      }
    };
    const onUp = (e: PointerEvent): void => {
      const wasClick = drag !== null && drag.moved <= 4;
      drag = null;
      if (!wasClick) return;
      const [sx, sy] = local(e);
      const { w, h } = size.current;
      const [wx, wy] = toWorld(cam.current, w, h, sx, sy);
      const geo = latest.current.geometry;
      const junction = nearestJunction(geo, wx, wy, 22 / cam.current.scale + 6);
      const edge = junction ? null : nearestEdge(geo, wx, wy, 10 / cam.current.scale + 3);
      useReplay.getState().set({ selectedSignal: junction, selectedEdge: edge });
    };
    const onDouble = (): void => {
      touched.current = false;
      cam.current = fit();
      schedule();
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("dblclick", onDouble);
    return () => {
      cv.removeEventListener("wheel", onWheel);
      cv.removeEventListener("pointerdown", onDown);
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerup", onUp);
      cv.removeEventListener("dblclick", onDouble);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="map-wrap" ref={wrap}>
      <canvas ref={canvas} className="map-canvas" aria-label="Recorded simulation map" />
    </div>
  );
}

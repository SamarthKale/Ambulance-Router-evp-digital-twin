import { useRef } from "react";

import { distanceSeries, extent, haltedSeries, linePath, speedSeries, timeAtFraction, type Series } from "./charts";
import { clock, useClockTime } from "./clock";
import type { RunInfo } from "./compare";
import { KIND_COLOR, KIND_LABEL, NOT_RECORDED } from "./format";
import { useReplay } from "./replayStore";

/** The scrubber: the whole run from t = 0, with a marker for every major recorded event. */
export function Timeline({ run, reference }: { run: RunInfo; reference: RunInfo | null }) {
  const t = useClockTime(30);
  const requestView = useReplay((s) => s.requestView);
  const track = useRef<HTMLDivElement>(null);
  const duration = clock.duration;
  const events = run.playback?.majorEvents ?? [];
  const ghostArrival = reference?.playback?.majorEvents.find((e) => e.kind === "arrival");

  const seekFrom = (clientX: number): void => {
    const el = track.current;
    if (!el || duration <= 0) return;
    const r = el.getBoundingClientRect();
    clock.seek(((clientX - r.left) / r.width) * duration);
  };
  const fraction = duration > 0 ? Math.min(1, t / duration) : 0;
  return (
    <div className="timeline" aria-label="Timeline">
      <div
        className={`track ${duration <= 0 ? "disabled" : ""}`}
        ref={track}
        role="slider"
        tabIndex={0}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(t)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFrom(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) seekFrom(e.clientX);
        }}
      >
        <div className="progress" style={{ width: `${fraction * 100}%` }} />
        {events.map((e, i) => (
          <button
            key={`${e.t}-${e.kind}-${i}`}
            className="marker"
            style={{ left: `${duration > 0 ? (e.t / duration) * 100 : 0}%`, background: KIND_COLOR[e.kind] ?? "#64748b" }}
            title={`${e.t.toFixed(1)} s · ${KIND_LABEL[e.kind] ?? e.kind}${e.junction ? ` ${e.junction}` : ""}`}
            onPointerDown={(ev) => ev.stopPropagation()}
            onClick={() => {
              clock.seek(e.t);
              if (e.junction) requestView({ kind: "junction", id: e.junction });
              else requestView({ kind: "ambulance" });
            }}
          />
        ))}
        {ghostArrival && duration > 0 && (
          <span className="ghost-mark" style={{ left: `${(ghostArrival.t / duration) * 100}%` }} title={`OFF ghost arrives at ${ghostArrival.t.toFixed(1)} s`} />
        )}
        <div className="thumb" style={{ left: `${fraction * 100}%` }} />
      </div>
      <div className="tl-legend muted small">
        {(["dispatch", "preempt", "reroute", "accident", "collision", "arrival"] as const).map((k) => (
          <span key={k}>
            <i style={{ background: KIND_COLOR[k] }} /> {KIND_LABEL[k]}
          </span>
        ))}
        <span>
          <i className="ghost-swatch" /> OFF ghost arrival
        </span>
      </div>
    </div>
  );
}

const W = 300;
const H = 90;

function Chart({
  title,
  note,
  actual,
  reference,
  unit,
}: {
  title: string;
  note?: string;
  actual: Series | null;
  reference: Series | null;
  unit: string;
}) {
  const t = useClockTime(20);
  const resume = useRef(false);
  const series = [actual, reference].filter((s): s is Series => s !== null);
  const e = extent(series, Math.max(1, clock.duration));
  const seek = (ev: React.PointerEvent<HTMLDivElement>): void => {
    const r = ev.currentTarget.getBoundingClientRect();
    clock.seek(timeAtFraction((ev.clientX - r.left) / r.width, e));
  };
  return (
    <div
      className="chart"
      onPointerEnter={() => {
        resume.current = clock.playing;
        clock.pause();
      }}
      onPointerMove={seek}
      onPointerLeave={() => {
        if (resume.current) clock.play();
        resume.current = false;
      }}
    >
      <div className="chart-title">
        {title} <span className="muted">{unit}</span>
      </div>
      {series.length === 0 ? (
        <div className="muted small pad">{NOT_RECORDED}</div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            {reference && <path d={linePath(reference, e, W, H)} className="line ref" />}
            {actual && <path d={linePath(actual, e, W, H)} className="line act" />}
            <line x1={(t / e.xmax) * W} x2={(t / e.xmax) * W} y1={0} y2={H} className="cursor" />
          </svg>
          <div className="axis muted small">
            <span>0 s</span>
            <span>max {e.ymax.toFixed(0)}</span>
            <span>{e.xmax.toFixed(0)} s</span>
          </div>
        </>
      )}
      {note && <div className="muted small">{note}</div>}
    </div>
  );
}

function PreemptionChart({ run }: { run: RunInfo }) {
  const t = useClockTime(20);
  const resume = useRef(false);
  const pb = run.playback;
  const segments = pb?.preemptions ?? [];
  const junctions = [...new Set(segments.map((s) => s.junction))];
  const xmax = Math.max(1, clock.duration);
  const row = 7;
  const height = Math.max(24, junctions.length * row + 4);
  return (
    <div
      className="chart"
      onPointerEnter={() => {
        resume.current = clock.playing;
        clock.pause();
      }}
      onPointerMove={(ev) => {
        const r = ev.currentTarget.getBoundingClientRect();
        clock.seek(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * xmax);
      }}
      onPointerLeave={() => {
        if (resume.current) clock.play();
        resume.current = false;
      }}
    >
      <div className="chart-title">
        Signals held by the safety controller <span className="muted">{segments.length} windows</span>
      </div>
      {!pb ? (
        <div className="muted small pad">{NOT_RECORDED}</div>
      ) : segments.length === 0 ? (
        <div className="muted small pad">No junction was preempted (normal signals).</div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ height: Math.min(H, height * 2.2) }}>
            {segments.map((s) => (
              <rect
                key={`${s.junction}-${s.start}`}
                x={(s.start / xmax) * W}
                y={junctions.indexOf(s.junction) * row + 2}
                width={Math.max(1, ((s.end - s.start) / xmax) * W)}
                height={row - 2}
                className={s.reachedGreen ? "seg green" : "seg"}
              />
            ))}
            <line x1={(t / xmax) * W} x2={(t / xmax) * W} y1={0} y2={height} className="cursor" />
          </svg>
          <div className="axis muted small">
            <span>0 s</span>
            <span>{junctions.length} junctions</span>
            <span>{xmax.toFixed(0)} s</span>
          </div>
        </>
      )}
    </div>
  );
}

export function ChartsPanel({ run, reference }: { run: RunInfo; reference: RunInfo | null }) {
  const a = run.playback;
  const r = reference?.playback ?? null;
  return (
    <div className="charts">
      <Chart title="Ambulance speed" unit="km/h" actual={a ? speedSeries(a, "actual") : null} reference={r ? speedSeries(r, "ghost") : null} />
      <Chart
        title="Progress: distance driven"
        unit="m"
        actual={a ? distanceSeries(a, "actual") : null}
        reference={r ? distanceSeries(r, "ghost") : null}
        note="from the recorded positions"
      />
      <Chart title="Queues: vehicles halted" unit="all roads" actual={a ? haltedSeries(a, "actual") : null} reference={r ? haltedSeries(r, "ghost") : null} note="recorded every 5 s" />
      <PreemptionChart run={run} />
    </div>
  );
}

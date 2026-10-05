"""Compact time-series telemetry of one experiment run, for the replay dashboard (Sprint 11).

The batch runs of Sprint 9 only keep aggregates (runs.csv). A replay needs what happened over
time, so a run can be re-run with a TelemetryRecorder watching it. The recorder is passive: it
reads the EngineState every tick the runner already produces and never touches the simulation, so
the run is the same run (SUMO is deterministic, CLAUDE.md section 6). scripts/record_telemetry.py
checks that against the recorded runs.csv row and stores the result in the file.

Everything in the file is read from the simulation: the ambulance's pose, its suggested route,
every signal state change with the controller's stage, the controller's decisions, SUMO's
collision counter, the independent monitor's violation counter, and per-road queue counts.
Nothing is computed that the simulation did not report. Times are seconds since the dispatch.

Per run (size at x1.5, mission ~100 s): ambulance 5 Hz, route and ETA 1 Hz, roads every 5 s, and
optionally the background traffic at 1 Hz (--traffic: larger, so only for showcase runs).
"""

from __future__ import annotations

import gzip
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from simulation.engine import EngineState
from simulation.incidents import is_wreck
from simulation.sumo import STEP_LENGTH, EdgeState
from simulation.vehicle import AMBULANCE_ID

SCHEMA_VERSION = 1
AMBULANCE_DT_S = 0.2
STATUS_DT_S = 1.0
EDGE_DT_S = 5.0
TRAFFIC_DT_S = 1.0
HOLD_AFTER_ARRIVAL_S = 5.0  # keep recording this long after the arrival (it parks)
MAX_RECORD_S = 450.0  # a mission that never arrives is not recorded for the whole window


def _every(dt_s: float) -> int:
    return max(1, round(dt_s / STEP_LENGTH))


def continues(old: tuple[str, ...], new: tuple[str, ...]) -> bool:
    """The new suggestion is the old one, driven further along (not a different route)
    (the same rule as evaluation.metrics, which counts route changes)."""
    return bool(new) and new[0] in old and old[old.index(new[0]) :] == new


class TelemetryRecorder:
    """Feed it every EngineState from the first tick after the dispatch."""

    def __init__(self, *, traffic: bool = False) -> None:
        self._traffic_on = traffic
        self._t0: float | None = None
        self._ticks = 0
        self._arrived_at: float | None = None
        self._mission_time: float | None = None
        self._done = False
        self._last_t = 0.0
        self._first_collisions = 0
        self._first_violations = 0
        self._collisions = 0
        self._violations = 0
        self._seen_decisions: set[tuple[float, str, str, bool, str]] = set()
        self._seen_incidents: set[str] = set()
        self._route: tuple[str, ...] | None = None
        self._edge_index: dict[str, int] = {}
        self._edge_ids: list[str] = []
        self._signal_ids: list[str] = []
        self._signal_last: list[tuple[str, str]] = []
        self.ambulance_edges: list[str] = []
        self.ambulance: list[list[Any]] = []
        self.status: list[list[Any]] = []
        self.routes: list[dict[str, Any]] = []
        self.signal_initial: list[str] = []
        self.signal_initial_control: list[str] = []
        self.signal_changes: list[list[Any]] = []
        self.events: list[dict[str, Any]] = []
        self.edge_samples: list[dict[str, Any]] = []
        self.incidents: list[dict[str, Any]] = []
        self.traffic_ids: list[str] = []
        self.traffic_types: list[str] = []
        self._traffic_index: dict[str, int] = {}
        self.traffic_samples: list[list[Any]] = []

    @property
    def done(self) -> bool:
        return self._done

    def observe(self, state: EngineState) -> None:
        if self._done:
            return
        snap = state.snapshot
        if self._t0 is None:
            self._start(state)
        assert self._t0 is not None
        t = round(snap.time - self._t0, 2)
        self._last_t = t
        amb = state.ambulance
        arrived_now = amb.status == "arrived" and self._arrived_at is None
        if arrived_now:
            self._arrived_at = t
            self._mission_time = None if amb.mission_time is None else round(amb.mission_time, 1)
            took = "" if amb.mission_time is None else f" after {amb.mission_time:.1f} s"
            self._event(t, "arrival", text=f"arrived{took}")
        n = self._ticks
        self._ticks += 1
        self._signals(t, state)
        self._decisions(t, state)
        self._counters(t, state)
        self._incidents(t, state)
        if n % _every(AMBULANCE_DT_S) == 0 or arrived_now:
            self._ambulance(t, state)
        if n % _every(STATUS_DT_S) == 0 or arrived_now:
            self._status(t, state)
        self._route_change(t, state)
        if n % _every(EDGE_DT_S) == 0:
            self._edges(t, state)
        if self._traffic_on and n % _every(TRAFFIC_DT_S) == 0:
            self._traffic(t, state)
        if t >= MAX_RECORD_S or (
            self._arrived_at is not None and t >= self._arrived_at + HOLD_AFTER_ARRIVAL_S
        ):
            self._done = True

    # ---- start: what the first tick shows ---------------------------------------------
    def _start(self, state: EngineState) -> None:
        snap = state.snapshot
        self._t0 = snap.time
        self._first_collisions = self._collisions = state.safety.collisions
        self._first_violations = self._violations = state.safety.violations
        self._signal_ids = [s.tls_id for s in snap.signals]
        stages = state.safety.stages
        self._signal_last = [(s.state, stages.get(s.tls_id, "program")) for s in snap.signals]
        self.signal_initial = [s for s, _ in self._signal_last]
        self.signal_initial_control = [c for _, c in self._signal_last]
        self._edge_ids = sorted(snap.edges)
        self._seen_decisions = {
            (e.time, e.junction, e.action, e.accepted, e.reason) for e in state.safety.events
        }  # decisions taken before the dispatch are not part of the mission
        self._event(0.0, "dispatch", text="ambulance dispatched")

    # ---- series ------------------------------------------------------------------------
    def _ambulance(self, t: float, state: EngineState) -> None:
        vehicle = state.snapshot.vehicle(AMBULANCE_ID)
        if vehicle is None:
            return
        index = self._edge_index.get(vehicle.edge)
        if index is None:
            index = self._edge_index[vehicle.edge] = len(self.ambulance_edges)
            self.ambulance_edges.append(vehicle.edge)
        self.ambulance.append(
            [
                t,
                round(vehicle.x, 1),
                round(vehicle.y, 1),
                round(vehicle.angle, 0),
                round(vehicle.speed, 1),
                index,
                vehicle.lane,
            ]
        )

    def _status(self, t: float, state: EngineState) -> None:
        route, ns = state.route, state.ambulance.next_signal
        self.status.append(
            [
                t,
                None if route is None else round(route.eta_s, 1),
                None if route is None else round(route.distance_m, 1),
                None if ns is None else ns.junction,
                None if ns is None else ns.state,
            ]
        )

    def _route_change(self, t: float, state: EngineState) -> None:
        route = state.route
        if route is None or state.ambulance.status != "driving":
            return
        edges = route.edges
        if self._route is not None and continues(self._route, edges):
            self._route = edges
            return
        first = self._route is None
        self._route = edges
        self.routes.append(
            {"t": t, "edges": list(edges), "eta": round(route.eta_s, 1), "routing": route.routing}
        )
        if not first:
            self._event(
                t,
                "reroute",
                text=f"route changed: {len(edges)} roads left, ETA {route.eta_s:.1f} s",
            )

    def _signals(self, t: float, state: EngineState) -> None:
        stages = state.safety.stages
        for i, s in enumerate(state.snapshot.signals):
            now = (s.state, stages.get(s.tls_id, "program"))
            if now != self._signal_last[i]:
                self._signal_last[i] = now
                self.signal_changes.append([t, i, now[0], now[1]])

    def _edges(self, t: float, state: EngineState) -> None:
        edges = state.snapshot.edges
        zero = EdgeState(mean_speed=0.0, halting=0, vehicles=0)
        rows = [edges.get(e, zero) for e in self._edge_ids]
        self.edge_samples.append(
            {
                "t": t,
                "halting": [r.halting for r in rows],
                "vehicles": [r.vehicles for r in rows],
                "speed": [round(r.mean_speed, 1) for r in rows],
            }
        )

    def _traffic(self, t: float, state: EngineState) -> None:
        flat: list[float] = []
        for v in state.snapshot.vehicles:
            if v.id == AMBULANCE_ID or is_wreck(v.id):
                continue
            index = self._traffic_index.get(v.id)
            if index is None:
                index = self._traffic_index[v.id] = len(self.traffic_ids)
                self.traffic_ids.append(v.id)
                self.traffic_types.append(v.type)
            flat += [index, round(v.x, 1), round(v.y, 1), round(v.angle, 0)]
        self.traffic_samples.append([t, flat])

    # ---- events: only what the simulation reported --------------------------------------
    def _event(
        self,
        t: float,
        kind: str,
        *,
        junction: str | None = None,
        edge: str | None = None,
        text: str = "",
        accepted: bool | None = None,
    ) -> None:
        self.events.append(
            {"t": t, "kind": kind, "junction": junction, "edge": edge, "text": text,
             "accepted": accepted}  # fmt: skip
        )

    def _decisions(self, t: float, state: EngineState) -> None:
        assert self._t0 is not None
        for e in state.safety.events:
            key = (e.time, e.junction, e.action, e.accepted, e.reason)
            if key in self._seen_decisions:
                continue
            self._seen_decisions.add(key)
            # The autopilot's per-road choice is logged as "reroute" by the controller even when
            # the route is the same one driven on: a real route change is recorded separately
            # (_route_change), so this stays a review of the next road.
            kind = "route_review" if e.action == "reroute" else e.action
            self._event(
                round(e.time - self._t0, 2),
                kind,
                junction=e.junction,
                text=e.reason,
                accepted=e.accepted,
            )

    def _counters(self, t: float, state: EngineState) -> None:
        if state.safety.collisions > self._collisions:
            gained = state.safety.collisions - self._collisions
            self._event(
                t,
                "collision",
                text=f"SUMO reported {gained} collision(s); parties not recorded here",
            )
        if state.safety.violations > self._violations:
            gained = state.safety.violations - self._violations
            self._event(t, "violation", text=f"independent monitor: {gained} new violation(s)")
        self._collisions = state.safety.collisions
        self._violations = state.safety.violations

    def _incidents(self, t: float, state: EngineState) -> None:
        for incident in state.incidents:
            if incident.id in self._seen_incidents:
                continue
            self._seen_incidents.add(incident.id)
            assert self._t0 is not None
            self.incidents.append(
                {
                    "id": incident.id,
                    "edge": incident.edge,
                    "lane": incident.lane,
                    "x": round(incident.x, 1),
                    "y": round(incident.y, 1),
                    "angle": round(incident.angle, 0),
                    "since": round(incident.since - self._t0, 2),
                }
            )
            self._event(t, "accident", edge=incident.edge, text=f"accident on {incident.edge}")

    # ---- result --------------------------------------------------------------------------
    def result(self) -> dict[str, Any]:
        """The run's telemetry (snake_case: the API models read it by field name)."""
        if self._t0 is None:
            raise ValueError("no state observed")
        return {
            "schema_version": SCHEMA_VERSION,
            "dispatch_s": round(self._t0, 2),
            "duration_s": self._last_t,
            "arrived": self._arrived_at is not None,
            "mission_time": self._mission_time,
            "ambulance_edges": self.ambulance_edges,
            "ambulance": self.ambulance,
            "status": self.status,
            "routes": self.routes,
            "signals": {
                "ids": self._signal_ids,
                "initial": self.signal_initial,
                "initial_control": self.signal_initial_control,
                "changes": self.signal_changes,
            },
            "events": sorted(self.events, key=lambda e: e["t"]),
            "edges": {
                "ids": self._edge_ids,
                "interval_s": EDGE_DT_S,
                "samples": self.edge_samples,
            },
            "traffic": (
                {
                    "interval_s": TRAFFIC_DT_S,
                    "ids": self.traffic_ids,
                    "types": self.traffic_types,
                    "samples": self.traffic_samples,
                }
                if self._traffic_on
                else None
            ),
            "incidents": self.incidents,
        }


# ---- files -------------------------------------------------------------------------------
def telemetry_path(folder: Path, arm: str, key: str) -> Path:
    return folder / arm / f"{key}.json.gz"


def write_telemetry(path: Path, data: dict[str, Any]) -> int:
    """gzip JSON, written atomically; mtime 0 so the same data gives the same bytes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, separators=(",", ":")).encode("utf-8")
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz:
            gz.write(payload)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return path.stat().st_size


def read_telemetry(path: Path) -> dict[str, Any]:
    with gzip.open(path, "rb") as fh:
        data: dict[str, Any] = json.loads(fh.read().decode("utf-8"))
    return data

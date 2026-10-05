"""Per-run metrics, measured the same way in every arm (CLAUDE.md section 14).

Fed one EngineState per tick from the dispatch to the end of the fixed window. SUMO's own
outputs (tripinfo time loss, log warnings) are parsed after the run (parse_tripinfo,
parse_log).
"""

from __future__ import annotations

import hashlib
import math
import re
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from simulation.engine import EngineState
from simulation.incidents import is_wreck
from simulation.sumo import STEP_LENGTH
from simulation.vehicle import AMBULANCE_ID

STOPPED = 0.1  # m/s: SUMO's halting threshold
MOVING = 1.0  # m/s: a new stop only counts after the ambulance moved again
RED_STOP_M = 30.0  # a stop this close to a red/yellow own link is a red-light stop
APPROACH_M = 150.0  # queue watch starts this far from the stop line


@dataclass
class _Approach:
    junction: str
    edge: str
    since: float
    cleared_after: float | None = None


class MissionMetrics:
    def __init__(self, dispatch_s: float, approach_edges: Iterable[str]) -> None:
        self.dispatch_s = dispatch_s
        self._approaches = tuple(sorted(approach_edges))
        self.travel_s: float | None = None
        self.wait_s = 0.0
        self.stops = 0
        self.red_stops = 0
        self.red_crossings = 0
        self.route_changes = 0
        self._queue_sum = 0.0
        self._bg_halted_s = 0.0
        self._ticks = 0
        self._moving = False
        self._last_link_state = "-"
        self._inside = False
        self._route: tuple[str, ...] | None = None
        self._approach: _Approach | None = None
        self._clear_times: list[float] = []
        self._first: EngineState | None = None
        self._last: EngineState | None = None

    def observe(self, state: EngineState) -> None:
        if self._first is None:
            self._first = state
        self._last = state
        snap, amb = state.snapshot, state.ambulance
        vehicle = snap.vehicle(AMBULANCE_ID)
        self._ticks += 1
        halted_amb = vehicle is not None and vehicle.speed < STOPPED
        total_halting = sum(e.halting for e in snap.edges.values())
        self._bg_halted_s += (total_halting - int(halted_amb and vehicle is not None)) * STEP_LENGTH
        if self._approaches:
            halting = sum(
                snap.edges[e].halting for e in self._approaches if e in snap.edges
            )  # fmt: skip
            self._queue_sum += halting / len(self._approaches)
        if amb.status == "arrived" and self.travel_s is None:
            self.travel_s = amb.mission_time
        if vehicle is None or amb.status != "driving":
            return
        self._observe_ambulance(state, vehicle.edge, vehicle.speed)

    def _observe_ambulance(self, state: EngineState, edge: str, speed: float) -> None:
        amb, now = state.ambulance, state.snapshot.time
        ns = amb.next_signal
        if speed < STOPPED:
            self.wait_s += STEP_LENGTH
            if self._moving:
                self.stops += 1
                if ns is not None and ns.distance <= RED_STOP_M and ns.state.lower() in "ryu":
                    self.red_stops += 1
            self._moving = False
        elif speed >= MOVING:
            self._moving = True
        inside = edge.startswith(":")
        if inside and not self._inside and self._last_link_state == "r":
            self.red_crossings += 1
        self._inside = inside
        self._last_link_state = ns.state if ns is not None else "-"
        self._watch_approach(state, edge, now)
        route = state.route.edges if state.route is not None else None
        if route is not None and self._route is not None and not _continues(self._route, route):
            self.route_changes += 1
        if route is not None:
            self._route = route

    def _watch_approach(self, state: EngineState, edge: str, now: float) -> None:
        """Time from the ambulance being APPROACH_M from a stop line until no vehicle waits
        in front of it there (or until it enters the junction, if the queue never clears)."""
        ns = state.ambulance.next_signal
        watch = self._approach
        if watch is not None and (edge.startswith(":") or edge != watch.edge):
            self._clear_times.append(
                watch.cleared_after if watch.cleared_after is not None else now - watch.since
            )
            self._approach = watch = None
        if watch is None and ns is not None and ns.distance <= APPROACH_M:
            if not edge.startswith(":"):
                self._approach = watch = _Approach(ns.junction, edge, now)
        if watch is not None and watch.cleared_after is None:
            e = state.snapshot.edges.get(watch.edge)
            vehicle = state.snapshot.vehicle(AMBULANCE_ID)
            own = int(vehicle is not None and vehicle.speed < STOPPED)
            if e is not None and e.halting - own <= 0:
                watch.cleared_after = now - watch.since

    def result(self) -> dict[str, float | int | None]:
        first, last = self._first, self._last
        if first is None or last is None:
            raise ValueError("no state observed")
        safety = last.safety
        return {
            "arrived": self.travel_s is not None,
            "travel_s": _round(self.travel_s),
            "wait_s": round(self.wait_s, 1),
            "stops": self.stops,
            "red_stops": self.red_stops,
            "red_crossings": self.red_crossings,
            "approach_clear_s": _round(_mean(self._clear_times)),
            "junctions_approached": len(self._clear_times),
            "queue_mean": round(self._queue_sum / max(1, self._ticks), 3),
            "bg_halted_s": round(self._bg_halted_s, 1),
            "route_changes": self.route_changes,
            "preemptions": safety.signals_preempted,
            "violations": safety.violations,
            "collisions": safety.collisions - first.safety.collisions,
            "dispatch_vehicles": sum(
                1 for v in first.snapshot.vehicles if v.id != AMBULANCE_ID and not is_wreck(v.id)
            ),
            "dispatch_hash": _traffic_hash(first),
        }


def _continues(old: tuple[str, ...], new: tuple[str, ...]) -> bool:
    """The new suggestion is the old one, driven further along (not a different route)."""
    return new[0] in old and old[old.index(new[0]) :] == new


def _traffic_hash(state: EngineState) -> str:
    """Fingerprint of the background traffic at dispatch: equal in every arm of a seed."""
    items = sorted(
        (v.id, round(v.x, 2), round(v.y, 2), round(v.speed, 2))
        for v in state.snapshot.vehicles
        if v.id != AMBULANCE_ID
    )
    return hashlib.sha256(repr(items).encode()).hexdigest()[:16]


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _round(value: float | None, digits: int = 1) -> float | None:
    return None if value is None or math.isnan(value) else round(value, digits)


# ---- SUMO outputs ----------------------------------------------------------------------
def parse_tripinfo(path: Path) -> dict[str, float | int]:
    """Background traffic from SUMO's tripinfo (written with unfinished trips at the end of
    the window): total time loss and the longest total wait of one vehicle. Vehicles that
    started before the dispatch carry time loss from before it, equal in every arm of a seed,
    so only paired differences are meaningful."""
    time_loss, max_wait, count = 0.0, 0.0, 0
    for _, element in ET.iterparse(path, events=("end",)):
        if element.tag != "tripinfo":
            continue
        vid = element.get("id", "")
        if vid != AMBULANCE_ID and not is_wreck(vid):
            time_loss += float(element.get("timeLoss", 0.0))
            max_wait = max(max_wait, float(element.get("waitingTime", 0.0)))
            count += 1
        element.clear()
    return {
        "bg_time_loss_s": round(time_loss, 1),
        "bg_max_wait_s": round(max_wait, 1),
        "bg_vehicles": count,
    }


_TIME = re.compile(r"time=(\d+(?:\.\d+)?)")


def parse_log(path: Path, since: float) -> dict[str, int]:
    """Warnings SUMO logged from `since` on: teleports flag a bad run (data quality)."""
    counts = {"teleports": 0, "emergency_brakings": 0, "sumo_collision_warnings": 0}
    if not path.exists():
        return counts
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        match = _TIME.search(line)
        if match is None or float(match.group(1)) < since:
            continue
        if "Teleporting vehicle" in line:
            counts["teleports"] += 1
        elif "emergency braking" in line:
            counts["emergency_brakings"] += 1
        elif "collision" in line:
            counts["sumo_collision_warnings"] += 1
    return counts

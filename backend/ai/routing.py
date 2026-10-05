"""Shortest-path routing for the ambulance with live costs (CLAUDE.md sections 6 and 13).

Pure logic: no TraCI, no sumolib. The simulation layer supplies the road graph (from the
net file) and the live conditions (TraCI subscriptions); this module only computes.

The cost of a route is the predicted time to the hospital, with every term rule-based:
  drive   edge length at the speed traffic allows the ambulance (live mean speed x its
          speed factor, capped at its 22 m/s top speed; free flow when the edge is empty)
  queue   vehicles halted at the stop line discharging at a 2 s headway per lane
  signal  OFF: the wait for the ambulance's own link to turn green, predicted from the
          fixed-time program at the moment the ambulance gets there. BASIC: preemption
          starts 15 s ahead, so only the part of the queue that the remaining 9 s of
          green (after 6 s of clearance) can't discharge is left. COORD: the queue-aware
          lead time discharges the queue first (Sprint 7).
  turn    a few seconds for slowing into a turn
  incident a large penalty, or a closed edge (Sprint 8)

Arrival times feed back into the signal prediction, so the search is a time-dependent
Dijkstra; waiting at a red light is first-in-first-out, which keeps it exact.
"""

from __future__ import annotations

import heapq
import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal

from ai.rules import PREEMPT_LEAD_S
from safety.invariants import ALL_RED_MIN_S, YELLOW_MIN_S

Mode = Literal["OFF", "BASIC", "COORD"]
TurnKind = Literal["left", "straight", "right", "uturn"]

AMBULANCE_TOP_SPEED = 22.0  # m/s (vType maxSpeed)
AMBULANCE_SPEED_FACTOR = 1.6  # vType speedFactor: how much faster than the limit it drives
AMBULANCE_ACCEL = 3.5  # m/s^2 (vType accel)
MIN_SPEED = 2.0  # m/s: even a crawling edge gets crossed eventually
HEADWAY_S = 2.0  # s per queued vehicle and lane (saturation flow ~1800 veh/h/lane)
PREDICTION_HORIZON_S = 30.0  # beyond this, expected values replace live predictions
CLEARANCE_S = YELLOW_MIN_S + ALL_RED_MIN_S
TURN_PENALTY_S: Mapping[TurnKind, float] = {
    "straight": 0.0,
    "left": 2.0,
    "right": 3.0,
    "uturn": 8.0,
}
_GREEN = frozenset("Gg")


def turn_kind(direction: str) -> TurnKind:
    """SUMO connection dir (s, l, L, r, R; t, or T in left-hand networks) -> turn kind."""
    if direction in ("l", "L"):
        return "left"
    if direction in ("r", "R"):
        return "right"
    if direction in ("t", "T"):
        return "uturn"
    return "straight"


# ---- road graph (static, built once from the net file) ------------------------------
@dataclass(frozen=True)
class Movement:
    """A way through the junction at the end of an edge."""

    to_edge: str
    turn: TurnKind
    tls: str | None  # signal controlling it, None at unsignalised junctions
    link_index: int | None  # its signal link (the curb-most lane's)
    length: float  # m through the junction


@dataclass(frozen=True)
class RoadEdge:
    id: str
    length: float  # m
    speed: float  # limit, m/s
    lanes: int
    to_node: str
    movements: tuple[Movement, ...]


@dataclass(frozen=True)
class RoadGraph:
    edges: Mapping[str, RoadEdge]

    def successors(self) -> dict[str, frozenset[str]]:
        return {e.id: frozenset(m.to_edge for m in e.movements) for e in self.edges.values()}

    def movement(self, from_edge: str, to_edge: str) -> Movement | None:
        edge = self.edges.get(from_edge)
        if edge is None:
            return None
        return next((m for m in edge.movements if m.to_edge == to_edge), None)


# ---- live conditions -------------------------------------------------------------------
@dataclass(frozen=True)
class EdgeTraffic:
    mean_speed: float  # m/s, all vehicles on the edge (SUMO reports the limit when empty)
    halting: int  # vehicles slower than 0.1 m/s
    vehicles: int


@dataclass(frozen=True)
class SignalClock:
    """Where a junction's fixed-time program is, for predicting future link states."""

    phase: int
    next_switch: float  # simulation time at which the current phase ends
    phases: tuple[tuple[str, float], ...]  # (state, duration s) of the program
    under_program: bool = True  # False while the safety controller drives the junction

    def _folded(self, now: float, t: float) -> float:
        """t moved back by whole cycles to within one cycle after the current phase ends:
        from then on the program repeats, so nothing about the signal changes."""
        ends = max(self.next_switch, now)
        cycle = sum(d for _, d in self.phases)
        if t > ends and cycle > 0:
            return ends + (t - ends) % cycle
        return t

    def _intervals(self, now: float) -> list[tuple[float, float, str]]:
        """(start, end, state) from now through the current phase and one more cycle."""
        index, start, end = self.phase, now, max(self.next_switch, now)
        spans = [(start, end, self.phases[index][0])]
        for _ in range(len(self.phases) * 2):
            index = (index + 1) % len(self.phases)
            start, end = end, end + self.phases[index][1]
            spans.append((start, end, self.phases[index][0]))
        return spans

    def state_at(self, now: float, t: float) -> str:
        """The program's state at time t >= now."""
        t = self._folded(now, max(t, now))
        return next(s for _, end, s in self._intervals(now) if t < end)

    def wait_for_green(self, now: float, t: float, link: int) -> float:
        """Seconds from t until `link` shows green (0 if it is green at t)."""
        t = self._folded(now, max(t, now))
        for start, end, state in self._intervals(now):
            if end > t and state[link] in _GREEN:
                return max(0.0, start - t)
        return expected_red_wait(self.phases, link)  # never green in the program


def expected_red_wait(phases: tuple[tuple[str, float], ...], link: int) -> float:
    """Mean wait for a random arrival: sum over red intervals of r^2 / 2, over the cycle."""
    cycle = sum(d for _, d in phases)
    if cycle <= 0:
        return 0.0
    greens = [i for i, (state, _) in enumerate(phases) if state[link] in _GREEN]
    if not greens:
        return cycle / 2
    rotated = phases[greens[0] :] + phases[: greens[0]]  # start on green: no run wraps
    reds: list[float] = []
    run = 0.0
    for state, duration in rotated:
        if state[link] in _GREEN:
            if run:
                reds.append(run)
            run = 0.0
        else:
            run += duration  # yellow counts: the ambulance stops for it in OFF
    if run:
        reds.append(run)
    return sum(r * r / 2 for r in reds) / cycle


@dataclass(frozen=True)
class Conditions:
    now: float
    mode: Mode
    traffic: Mapping[str, EdgeTraffic] = field(default_factory=dict)  # empty: free flow
    signals: Mapping[str, SignalClock] = field(default_factory=dict)  # empty: cycle averages
    programs: Mapping[str, tuple[tuple[str, float], ...]] = field(default_factory=dict)
    incidents: Mapping[str, float] = field(default_factory=dict)  # edge -> s (inf = closed)


# ---- cost model ----------------------------------------------------------------------
def drive_time(edge: RoadEdge, distance: float, traffic: EdgeTraffic | None) -> float:
    """Time to drive `distance` along the edge at the speed moving traffic allows. Vehicles
    standing in the queue are charged by queue_time, so they don't slow the drive too."""
    free = min(AMBULANCE_TOP_SPEED, edge.speed * AMBULANCE_SPEED_FACTOR)
    if traffic is None:
        return distance / free
    moving = traffic.vehicles - traffic.halting
    if moving < max(1, edge.lanes):
        # Fewer moving cars than lanes: the ambulance passes them (one car creeping up to a
        # queue is not the flow speed: it once priced a 229 m road at 70 s).
        return distance / free
    moving_mean = traffic.mean_speed * traffic.vehicles / moving  # halted ones count ~0
    allowed = min(free, max(MIN_SPEED, moving_mean * AMBULANCE_SPEED_FACTOR))
    return distance / allowed


def acceleration_loss(speed: float) -> float:
    """Seconds lost reaching top speed from `speed`, compared with already being there."""
    gap = max(0.0, AMBULANCE_TOP_SPEED - speed)
    return gap * gap / (2 * AMBULANCE_ACCEL * AMBULANCE_TOP_SPEED)


def queue_time(edge: RoadEdge, traffic: EdgeTraffic | None) -> float:
    if traffic is None:
        return 0.0
    return traffic.halting / max(1, edge.lanes) * HEADWAY_S


def junction_delay(
    edge: RoadEdge, move: Movement, arrive: float, conditions: Conditions
) -> tuple[float, float]:
    """(queue s, signal s) at the end of `edge` for someone reaching the stop line at `arrive`.

    Within PREDICTION_HORIZON_S the live queue and the program's exact timing are used.
    Further ahead, arrival-time errors make exact predictions noise (routes then chase
    "lucky greens" that are gone by the time the ambulance gets there), so expected values
    take over: half the current queue and the program's average red wait."""
    near = arrive - conditions.now <= PREDICTION_HORIZON_S
    queue = queue_time(edge, conditions.traffic.get(edge.id)) * (1.0 if near else 0.5)
    if move.tls is None or move.link_index is None:
        return queue * 0.5, 0.0  # priority junction: the queue only merges
    if conditions.mode in ("BASIC", "COORD"):
        # Preempted: no red wait, and the queue gets BASIC's head start of green. COORD
        # clears more of it, but the cleared cars then drive ahead of the ambulance, so it
        # is priced the same: route choice must not depend on the signal mode, or comparing
        # the modes would also compare routes.
        head_start = PREEMPT_LEAD_S - CLEARANCE_S
        return max(0.0, queue - head_start), 0.0
    clock = conditions.signals.get(move.tls)
    program = conditions.programs.get(move.tls)
    if near and clock is not None and clock.under_program:
        # wait for green first; the queue in front only starts moving then
        signal = clock.wait_for_green(conditions.now, arrive, move.link_index)
    elif program:
        signal = expected_red_wait(program, move.link_index)
    elif clock is not None:
        signal = expected_red_wait(clock.phases, move.link_index)
    else:
        signal = 0.0
    return queue, signal


# ---- search --------------------------------------------------------------------------
@dataclass(frozen=True)
class RouteTurn:
    junction: str
    turn: TurnKind
    edge: str  # the road taken after the junction


@dataclass(frozen=True)
class RoutePlan:
    edges: tuple[str, ...]  # from the ambulance's road to the hospital road
    eta_s: float  # predicted seconds from `computed_at` to arrival
    distance_m: float
    turns: tuple[RouteTurn, ...]  # one per junction on the way
    drive_s: float
    queue_s: float
    signal_s: float
    computed_at: float

    @property
    def next_turn(self) -> RouteTurn | None:
        return self.turns[0] if self.turns else None


@dataclass(order=True)
class _Label:
    time: float
    edge: str = field(compare=False)


# Hysteresis: a new suggestion replaces the current one only if it is clearly faster, so the
# advice doesn't flip between two near-equal routes every second.
SWITCH_MIN_S = 5.0
SWITCH_MIN_FRACTION = 0.1


def clearly_faster(new: RoutePlan, current: RoutePlan) -> bool:
    return new.eta_s < current.eta_s - max(SWITCH_MIN_S, SWITCH_MIN_FRACTION * current.eta_s)


def _stop_line(edge: RoadEdge, offset: float, t: float, conditions: Conditions) -> float:
    """When someone on `edge` at `offset` at time `t` reaches its stop line."""
    traffic = conditions.traffic.get(edge.id)
    extra = conditions.incidents.get(edge.id, 0.0)
    return t + drive_time(edge, max(0.0, edge.length - offset), traffic) + extra


def _through(move: Movement) -> float:
    return TURN_PENALTY_S[move.turn] + move.length / (AMBULANCE_TOP_SPEED / 2)


def evaluate_route(
    graph: RoadGraph,
    edges: tuple[str, ...],
    start_pos: float,
    destination_pos: float,
    conditions: Conditions,
    start_speed: float = AMBULANCE_TOP_SPEED,
) -> RoutePlan | None:
    """The predicted time and distance of one given route, or None if it can't be driven."""
    if not edges:
        return None
    now = conditions.now
    t = now + acceleration_loss(start_speed)
    drive, queue, signal = t - now, 0.0, 0.0
    distance = 0.0
    for i, edge_id in enumerate(edges):
        edge = graph.edges.get(edge_id)
        if edge is None or math.isinf(conditions.incidents.get(edge_id, 0.0)):
            return None
        offset = start_pos if i == 0 else 0.0
        if i == len(edges) - 1:
            remaining = max(0.0, destination_pos - offset)
            dt = drive_time(edge, remaining, conditions.traffic.get(edge_id))
            dt += conditions.incidents.get(edge_id, 0.0)
            t, drive, distance = t + dt, drive + dt, distance + remaining
            break
        move = graph.movement(edge_id, edges[i + 1])
        if move is None:
            return None
        stop_line = _stop_line(edge, offset, t, conditions)
        q, s = junction_delay(edge, move, stop_line, conditions)
        through = _through(move)
        drive += stop_line - t + through
        queue, signal = queue + q, signal + s
        distance += max(0.0, edge.length - offset)
        t = stop_line + q + s + through
    turns = tuple(
        RouteTurn(graph.edges[a].to_node, graph.movement(a, b).turn, b)  # type: ignore[union-attr]
        for a, b in zip(edges, edges[1:], strict=False)
    )
    return RoutePlan(
        edges=tuple(edges),
        eta_s=round(t - now, 2),
        distance_m=round(distance, 1),
        turns=turns,
        drive_s=round(drive, 2),
        queue_s=round(queue, 2),
        signal_s=round(signal, 2),
        computed_at=now,
    )


def plan_route(
    graph: RoadGraph,
    start_edge: str,
    start_pos: float,
    destination_edge: str,
    destination_pos: float,
    conditions: Conditions,
    start_speed: float = AMBULANCE_TOP_SPEED,
) -> RoutePlan | None:
    """Fastest route from `start_pos` on `start_edge` to `destination_pos` on the
    destination edge, or None if there is none (e.g. every way is closed). `start_speed`:
    the ambulance's speed now (a standing start costs a few seconds)."""
    if start_edge not in graph.edges or destination_edge not in graph.edges:
        return None
    # label: time the ambulance is at the start of an edge (or at start_pos on the first)
    first = conditions.now + acceleration_loss(start_speed)
    best: dict[str, float] = {start_edge: first}
    parent: dict[str, str] = {}
    heap = [_Label(first, start_edge)]
    done: set[str] = set()
    while heap:
        label = heapq.heappop(heap)
        edge_id = label.edge
        if edge_id in done:
            continue
        done.add(edge_id)
        offset = start_pos if edge_id == start_edge else 0.0
        if edge_id == destination_edge and (edge_id != start_edge or destination_pos >= offset):
            path = [destination_edge]
            while path[-1] != start_edge:
                path.append(parent[path[-1]])
            path.reverse()
            # price the path with the same model, so the plan and evaluate_route agree
            return evaluate_route(
                graph, tuple(path), start_pos, destination_pos, conditions, start_speed
            )
        if math.isinf(conditions.incidents.get(edge_id, 0.0)):
            continue  # closed
        edge = graph.edges[edge_id]
        stop_line = _stop_line(edge, offset, label.time, conditions)
        for move in edge.movements:
            if move.to_edge in done or math.isinf(conditions.incidents.get(move.to_edge, 0.0)):
                continue
            queue, signal = junction_delay(edge, move, stop_line, conditions)
            t = stop_line + queue + signal + _through(move)
            if t < best.get(move.to_edge, math.inf):
                best[move.to_edge] = t
                parent[move.to_edge] = edge_id
                heapq.heappush(heap, _Label(t, move.to_edge))
    return None

"""Simulation engine: the single runtime owner of SUMO/TraCI (CLAUDE.md section 2.7).

Any thread may submit() commands. The engine thread applies them between steps, runs
manual control, the safety controller and (in BASIC mode) the preemption rule, steps SUMO
at 10 Hz real time and publishes an immutable EngineState.
Tests can drive open()/tick()/close() synchronously instead of starting the thread.

Tick order:
  commands -> autopilot (batch) -> manual.step -> controller.step -> traffic_lights.apply
  -> simulationStep -> manual.observe -> monitor.observe -> rule -> controller.request_*
  -> route (every ROUTE_EVERY_S, or on a new road) -> publish
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from collections import deque
from collections.abc import Callable, Iterable, Mapping
from concurrent.futures import Future
from dataclasses import dataclass
from itertools import count
from typing import Literal

from ai.routing import (
    Conditions,
    EdgeTraffic,
    RoutePlan,
    RouteTurn,
    SignalClock,
    clearly_faster,
    evaluate_route,
    plan_route,
)
from ai.rules import AmbulanceView, Preempt, Release, RuleAction, basic_preemption
from safety.controller import SafetyController, SafetyEvent, Stage, UnsafePlanError
from safety.monitor import SafetyMonitor
from simulation.manual_control import DEADMAN_S, OK, CommandResult, ManualController
from simulation.network import RoadNetwork
from simulation.sumo import STEP_LENGTH, Snapshot, SumoConfig, SumoSimulation, VehicleState
from simulation.traffic_lights import TrafficLights, load_signal_tables
from simulation.vehicle import AMBULANCE_ID, AmbulanceStatus, Direction, spawn_ambulance

log = logging.getLogger(__name__)

RESTART_DELAY_S = 1.0  # after a crash, wait this long before restarting SUMO
# Small timing jitter is caught up; after a longer stall (e.g. a reset restarting SUMO)
# the loop resyncs to the wall clock instead of bursting ticks, so motion stays smooth.
MAX_LAG_S = STEP_LENGTH
RECENT_EVENTS = 8
STATS_WINDOW = 300  # ticks (30 s) for the timing percentiles
ROUTE_EVERY_S = 1.0  # re-plan on a timer (and on every new road), not every step

Mode = Literal["OFF", "BASIC", "COORD"]
Routing = Literal["dynamic", "static"]  # live costs, or free-flow costs fixed at dispatch
Control = Literal["manual", "autopilot"]  # autopilot: batch experiments only (section 14)
Rule = Callable[[AmbulanceView | None, Iterable[str]], list[RuleAction]]


@dataclass(frozen=True)
class SpawnAmbulance:
    pass


@dataclass(frozen=True)
class Drive:
    throttle: float
    brake: float


@dataclass(frozen=True)
class Turn:
    direction: Direction


@dataclass(frozen=True)
class ChangeLane:
    direction: Direction


@dataclass(frozen=True)
class SetMode:
    mode: Mode


@dataclass(frozen=True)
class Reset:
    pass


Command = SpawnAmbulance | Drive | Turn | ChangeLane | SetMode | Reset


@dataclass(frozen=True)
class SafetyStatus:
    stages: Mapping[str, Stage]  # per junction: program, clearing, preempted, recovering
    signals_preempted: int
    violations: int  # independent monitor, since the simulation started
    collisions: int  # SUMO-detected, since the simulation started
    events: tuple[SafetyEvent, ...]  # most recent last


@dataclass(frozen=True)
class EngineStats:
    tick_ms_p50: float | None  # whole engine tick: commands, control, SUMO step, safety
    tick_ms_p95: float | None
    tick_ms_max: float | None
    sumo_step_ms_p50: float | None  # simulationStep + subscription replies only
    vehicles: int


def _percentile(sorted_values: list[float], q: float) -> float | None:
    if not sorted_values:
        return None
    return round(sorted_values[min(len(sorted_values) - 1, int(q * len(sorted_values)))], 2)


@dataclass(frozen=True)
class RouteStatus:
    """The suggested route (advisory while driving manually) and how the ambulance stands."""

    plan: RoutePlan  # as computed at plan.computed_at
    routing: Routing
    edges: tuple[str, ...]  # the plan from the ambulance's road on
    turns: tuple[RouteTurn, ...]  # the junctions still ahead
    eta_s: float  # counted down since the plan was made
    distance_m: float  # remaining along the suggested route, from where the ambulance is
    follows: bool  # the road the ambulance will take next is the suggested one


@dataclass(frozen=True)
class EngineState:
    seq: int
    mode: Mode
    snapshot: Snapshot
    ambulance: AmbulanceStatus
    safety: SafetyStatus
    route: RouteStatus | None = None


class SimulationEngine:
    def __init__(
        self,
        config: SumoConfig,
        *,
        realtime: bool = True,
        clock: Callable[[], float] = time.monotonic,
        deadman_s: float | None = DEADMAN_S,
        mode: Mode = "OFF",
        rule: Rule = basic_preemption,
        warmup_s: float = 0.0,  # fast-forward this much simulated time on open (live demo)
        routing: Routing = "dynamic",
        control: Control = "manual",
    ) -> None:
        self.config = config
        self.warmup_s = warmup_s
        self.routing: Routing = routing
        self.control: Control = control
        self.network = RoadNetwork(config.scenario)
        self.graph = self.network.road_graph()
        self._successors = self.graph.successors()
        self.tables = load_signal_tables(config.net_path)
        self._programs = {tls: table.phases for tls, table in self.tables.items()}
        self._route: RoutePlan | None = None
        self._route_start = ""
        self.realtime = realtime
        self.mode: Mode = mode
        self.error: str | None = None
        self._clock = clock
        self._deadman_s = deadman_s
        self._rule = rule
        self._commands: queue.SimpleQueue[tuple[Command, Future[CommandResult]]] = (
            queue.SimpleQueue()
        )
        self._sim: SumoSimulation | None = None
        self._manual: ManualController | None = None
        self._lights: TrafficLights | None = None
        self._controller = SafetyController(self.tables)
        self._monitor = SafetyMonitor(self.tables)
        self._collisions = 0
        self._now = 0.0
        self._ambulance_class: str | None = None
        self._seq = count(1)
        self._route_ids = count(1)
        self._latest: EngineState | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._tick_ms: deque[float] = deque(maxlen=STATS_WINDOW)
        self._step_ms: deque[float] = deque(maxlen=STATS_WINDOW)

    # ---- any thread ----------------------------------------------------------
    def stats(self) -> EngineStats:
        """Tick timing over the last STATS_WINDOW ticks (copied, so any thread may call)."""
        ticks, steps = sorted(self._tick_ms), sorted(self._step_ms)
        latest = self._latest
        return EngineStats(
            tick_ms_p50=_percentile(ticks, 0.5),
            tick_ms_p95=_percentile(ticks, 0.95),
            tick_ms_max=ticks[-1] if ticks else None,
            sumo_step_ms_p50=_percentile(steps, 0.5),
            vehicles=latest.snapshot.vehicle_count if latest else 0,
        )

    def submit(self, command: Command) -> Future[CommandResult]:
        """Queue a command for the simulation thread; the future resolves after it ran."""
        future: Future[CommandResult] = Future()
        self._commands.put((command, future))
        return future

    @property
    def latest(self) -> EngineState | None:
        return self._latest

    @property
    def running(self) -> bool:
        return self._sim is not None

    @property
    def sumo_pid(self) -> int | None:
        sim = self._sim
        return sim.pid if sim is not None else None

    def start(self, publish: Callable[[EngineState], None]) -> None:
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, args=(publish,), name="sumo-engine", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 10.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)
            self._thread = None

    # ---- simulation thread (or a test driving the engine synchronously) ----------
    def open(self) -> None:
        self._sim = SumoSimulation(self.config)
        self._sim.start()
        conn = self._sim.connection
        self._manual = ManualController(conn, self.network, self._clock, self._deadman_s)
        self._lights = TrafficLights(conn)
        self._controller = SafetyController(self.tables)
        self._monitor = SafetyMonitor(self.tables)
        self._collisions = 0
        self._now = self._sim.snapshot().time
        self._ambulance_class = None
        self._route, self._route_start = None, ""
        while self._now < self.warmup_s - STEP_LENGTH / 2:  # traffic already on the roads
            snap = self._sim.step()
            self._collisions += snap.collisions
            # The monitor watches the warm-up too: started mid-cycle it would not know how
            # long a link has been red, and would flag the next normal green as an R3 breach.
            self._monitor.observe(snap.time, ((s.tls_id, s.state) for s in snap.signals))
            self._now = snap.time

    def close(self) -> None:
        if self._sim is not None:
            self._sim.close()
        self._sim = None
        self._manual = None
        self._lights = None

    def tick(self) -> EngineState:
        started = time.perf_counter()
        self._apply_commands()
        sim, manual, lights = self._require()
        if self.control == "autopilot":
            self._autopilot()
        manual.step(STEP_LENGTH)
        lights.apply(self._controller.step(self._now))
        step_started = time.perf_counter()
        snap = sim.step()
        self._step_ms.append((time.perf_counter() - step_started) * 1000)
        vehicle = snap.vehicle(AMBULANCE_ID)
        manual.observe(vehicle, snap.time)
        ambulance = manual.status(snap.time)
        self._monitor.observe(snap.time, ((s.tls_id, s.state) for s in snap.signals))
        self._collisions += snap.collisions
        if self.mode == "BASIC":
            self._run_rule(snap, vehicle, ambulance)
        self._now = snap.time
        route = self._update_route(snap, vehicle, ambulance)
        state = EngineState(
            next(self._seq), self.mode, snap, ambulance, self._safety_status(), route
        )
        self._latest = state
        self._tick_ms.append((time.perf_counter() - started) * 1000)
        return state

    # ---- routing (advisory while driving manually; followed by the batch autopilot) -----
    def _update_route(
        self, snap: Snapshot, vehicle: VehicleState | None, ambulance: AmbulanceStatus
    ) -> RouteStatus | None:
        _, manual, _ = self._require()
        if vehicle is None or ambulance.status != "driving":
            self._route, self._route_start = None, ""
            return None
        if vehicle.edge.startswith(":"):  # inside a junction: plan from the road after it
            start, pos = manual.upcoming_edge, 0.0
        else:
            start, pos = vehicle.edge, manual.lane_position
        if start is None or start not in self.graph.edges:
            return None
        plan = self._route
        stale = plan is None or start != self._route_start
        if plan is not None and self.routing == "dynamic":
            stale = stale or snap.time - plan.computed_at >= ROUTE_EVERY_S - 1e-6
        elif plan is not None and start in plan.edges:
            stale = False  # static: keep the dispatch plan while the ambulance stays on it
        if stale:
            hospital = self.network.hospital
            conditions = self._conditions(snap, vehicle)
            fresh = plan_route(
                self.graph, start, pos, hospital.edge, hospital.pos, conditions, vehicle.speed
            )
            if fresh is not None and plan is not None and start in plan.edges:
                # keep the current suggestion (re-priced) unless the new one is clearly faster
                kept = evaluate_route(
                    self.graph,
                    plan.edges[plan.edges.index(start) :],
                    pos,
                    hospital.pos,
                    conditions,
                    vehicle.speed,
                )
                if kept is not None and not clearly_faster(fresh, kept):
                    fresh = kept
            if fresh is not None:
                plan, self._route, self._route_start = fresh, fresh, start
        if plan is None:
            return None
        index = plan.edges.index(start) if start in plan.edges else 0
        ahead = plan.edges[index:]
        distance = self._remaining_m(ahead, pos)
        follows = vehicle.edge.startswith(":") or (
            len(ahead) < 2
            or ambulance.planned_turn is None
            or ambulance.planned_turn.edge == ahead[1]
        )
        return RouteStatus(
            plan=plan,
            routing=self.routing,
            edges=ahead,
            turns=plan.turns[index:],
            eta_s=max(0.0, plan.eta_s - (snap.time - plan.computed_at)),
            distance_m=distance,
            follows=follows,
        )

    def _remaining_m(self, edges: tuple[str, ...], pos: float) -> float:
        hospital = self.network.hospital
        if len(edges) == 1:
            return max(0.0, hospital.pos - pos)
        lengths = self.graph.edges
        middle = sum(lengths[e].length for e in edges[1:-1])
        return max(0.0, lengths[edges[0]].length - pos) + middle + hospital.pos

    def _conditions(self, snap: Snapshot, vehicle: VehicleState) -> Conditions:
        if self.routing == "static":  # free flow, average signal waits: what a map would say
            return Conditions(now=snap.time, mode=self.mode, programs=self._programs)
        traffic = {}
        for edge_id, e in snap.edges.items():
            if edge_id == vehicle.edge:
                # The ambulance's own road: cars on it are as likely behind as ahead, and the
                # averages can't tell; only the queue at the stop line counts (minus itself).
                halting = max(0, e.halting - int(vehicle.speed < 0.1))
                traffic[edge_id] = EdgeTraffic(self.graph.edges[edge_id].speed, halting, halting)
            else:
                traffic[edge_id] = EdgeTraffic(e.mean_speed, e.halting, e.vehicles)
        stages = self._controller.stages()
        signals = {
            s.tls_id: SignalClock(
                phase=s.phase,
                next_switch=s.next_switch,
                phases=self._programs[s.tls_id],
                under_program=stages.get(s.tls_id) == "program"
                and s.program == self.tables[s.tls_id].program_id,
            )
            for s in snap.signals
            if s.tls_id in self._programs
        }
        return Conditions(
            now=snap.time,
            mode=self.mode,
            traffic=traffic,
            signals=signals,
            programs=self._programs,
        )

    def _autopilot(self) -> None:
        """Batch runs: full throttle, and take the suggested road at every junction once the
        safety controller has accepted the route (CLAUDE.md section 2.3)."""
        sim, manual, _ = self._require()
        latest = self._latest
        vehicle = latest.snapshot.vehicle(AMBULANCE_ID) if latest else None
        if vehicle is None or latest is None or latest.ambulance.status != "driving":
            return
        manual.set_drive(1.0, 0.0)
        plan = self._route
        if plan is None or vehicle.edge != plan.edges[0] or len(plan.edges) < 2:
            return
        target = plan.edges[1]
        planned = manual.planned
        if planned is not None and planned.edge == target:
            return
        if self._ambulance_class is None:
            self._ambulance_class = sim.connection.vehicle.getVehicleClass(AMBULANCE_ID)
        decision = self._controller.review_reroute(
            self._now,
            AMBULANCE_ID,
            self._ambulance_class,
            junction=self.graph.edges[vehicle.edge].to_node,
            current_edge=vehicle.edge,
            route=plan.edges,
            successors=self._successors,
            destination=self.network.hospital.edge,
        )
        if decision.accepted:
            manual.request_target(target)

    def _run_rule(
        self, snap: Snapshot, vehicle: VehicleState | None, ambulance: AmbulanceStatus
    ) -> None:
        controller = self._controller
        try:
            view = self._ambulance_view(vehicle, ambulance)
            states = {s.tls_id: s.state for s in snap.signals}
            for action in self._rule(view, controller.held_for(AMBULANCE_ID)):
                match action:
                    case Preempt(junction=junction, link_index=link, eta_s=eta):
                        vehicle_class = view.vehicle_class if view else ""
                        controller.request_preempt(
                            snap.time,
                            junction,
                            link,
                            AMBULANCE_ID,
                            vehicle_class,
                            states[junction],
                            eta,
                        )
                    case Release(junction=junction, reason=reason):
                        controller.request_release(snap.time, junction, AMBULANCE_ID, reason)
        except UnsafePlanError:
            raise  # the controller itself is wrong: let the engine restart SUMO cleanly
        except Exception as exc:  # decision logic failed: fall back to the normal programs
            log.exception("preemption rule failed")
            controller.release_all(
                snap.time,
                f"decision logic failed ({exc}); back to normal programs, mode OFF",
                action="fail_safe",
            )
            self.mode = "OFF"

    def _ambulance_view(
        self, vehicle: VehicleState | None, ambulance: AmbulanceStatus
    ) -> AmbulanceView | None:
        if vehicle is None or ambulance.status != "driving":
            return None
        if self._ambulance_class is None:
            sim, _, _ = self._require()
            self._ambulance_class = sim.connection.vehicle.getVehicleClass(AMBULANCE_ID)
        ns = ambulance.next_signal
        return AmbulanceView(
            vehicle_id=AMBULANCE_ID,
            vehicle_class=self._ambulance_class,
            edge=vehicle.edge,
            speed=vehicle.speed,
            next_junction=ns.junction if ns else None,
            next_link=ns.link_index if ns else None,
            next_distance=ns.distance if ns else None,
        )

    def _safety_status(self) -> SafetyStatus:
        controller = self._controller
        return SafetyStatus(
            stages=controller.stages(),
            signals_preempted=controller.signals_preempted,
            violations=self._monitor.violations,
            collisions=self._collisions,
            events=tuple(controller.events)[-RECENT_EVENTS:],
        )

    def _require(self) -> tuple[SumoSimulation, ManualController, TrafficLights]:
        if self._sim is None or self._manual is None or self._lights is None:
            raise RuntimeError("engine is not open")
        return self._sim, self._manual, self._lights

    def _apply_commands(self) -> None:
        while True:
            try:
                command, future = self._commands.get_nowait()
            except queue.Empty:
                return
            try:
                result = self._apply(command)
            except Exception as exc:  # a bad command must not kill the loop
                log.exception("command %s failed", command)
                result = CommandResult(False, f"internal error: {exc}")
            future.set_result(result)

    def _apply(self, command: Command) -> CommandResult:
        sim, manual, _ = self._require()
        match command:
            case Reset():
                self.close()
                self.open()
                return CommandResult(True, "simulation restarted")
            case SpawnAmbulance():
                spawn_ambulance(sim.connection, self.network, f"ambulance_{next(self._route_ids)}")
                manual.on_spawned(self._now)
                self._ambulance_class = None
                return CommandResult(True, "ambulance dispatched from the depot")
            case Drive(throttle=throttle, brake=brake):
                manual.set_drive(throttle, brake)
                return OK
            case Turn(direction=direction):
                return manual.request_turn(direction)
            case ChangeLane(direction=direction):
                return manual.request_lane(direction)
            case SetMode(mode=mode):
                return self._set_mode(mode)

    def _set_mode(self, mode: Mode) -> CommandResult:
        if mode == "COORD":
            return CommandResult(False, "COORD mode arrives in Sprint 7")
        if mode == self.mode:
            return CommandResult(True, f"already in {mode} mode")
        if mode == "OFF":
            self._controller.release_all(self._now, "mode switched to OFF")
        self.mode = mode
        return CommandResult(True, f"{mode} mode")

    def _fail_pending(self, reason: str) -> None:
        while True:
            try:
                _, future = self._commands.get_nowait()
            except queue.Empty:
                return
            future.set_result(CommandResult(False, reason))

    def _run(self, publish: Callable[[EngineState], None]) -> None:
        next_tick = time.perf_counter()
        while not self._stop.is_set():
            try:
                if self._sim is None:
                    self.open()
                    self.error = None
                state = self.tick()
            except Exception as exc:
                log.exception("simulation failed; restarting in %.0f s", RESTART_DELAY_S)
                self.error = f"{type(exc).__name__}: {exc}"
                self.close()
                self._fail_pending("simulation is restarting")
                self._stop.wait(RESTART_DELAY_S)
                next_tick = time.perf_counter()
                continue
            try:
                publish(state)
            except Exception:
                log.exception("publishing state %d failed", state.seq)
            if self.realtime:
                next_tick += STEP_LENGTH
                delay = next_tick - time.perf_counter()
                if delay > 0:
                    self._stop.wait(delay)
                elif delay < -MAX_LAG_S:
                    next_tick = time.perf_counter()
        self.close()
        self._fail_pending("simulation stopped")

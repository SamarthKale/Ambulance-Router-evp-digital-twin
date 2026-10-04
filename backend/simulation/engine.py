"""Simulation engine: the single runtime owner of SUMO/TraCI (CLAUDE.md section 2.7).

Any thread may submit() commands. The engine thread applies them between steps, runs
manual control, steps SUMO at 10 Hz real time and publishes an immutable EngineState.
Tests can drive open()/tick()/close() synchronously instead of starting the thread.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass
from itertools import count

from simulation.manual_control import DEADMAN_S, OK, CommandResult, ManualController
from simulation.network import RoadNetwork
from simulation.sumo import STEP_LENGTH, Snapshot, SumoConfig, SumoSimulation
from simulation.vehicle import AMBULANCE_ID, AmbulanceStatus, Direction, spawn_ambulance

log = logging.getLogger(__name__)

RESTART_DELAY_S = 1.0  # after a crash, wait this long before restarting SUMO
# Small timing jitter is caught up; after a longer stall (e.g. a reset restarting SUMO)
# the loop resyncs to the wall clock instead of bursting ticks, so motion stays smooth.
MAX_LAG_S = STEP_LENGTH


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
class Reset:
    pass


Command = SpawnAmbulance | Drive | Turn | ChangeLane | Reset


@dataclass(frozen=True)
class EngineState:
    seq: int
    mode: str  # OFF until BASIC/COORD arrive (Sprints 3 and 7)
    snapshot: Snapshot
    ambulance: AmbulanceStatus


class SimulationEngine:
    def __init__(
        self,
        config: SumoConfig,
        *,
        realtime: bool = True,
        clock: Callable[[], float] = time.monotonic,
        deadman_s: float | None = DEADMAN_S,
    ) -> None:
        self.config = config
        self.network = RoadNetwork(config.scenario)
        self.realtime = realtime
        self.error: str | None = None
        self._clock = clock
        self._deadman_s = deadman_s
        self._commands: queue.SimpleQueue[tuple[Command, Future[CommandResult]]] = (
            queue.SimpleQueue()
        )
        self._sim: SumoSimulation | None = None
        self._manual: ManualController | None = None
        self._seq = count(1)
        self._route_ids = count(1)
        self._latest: EngineState | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ---- any thread ----------------------------------------------------------
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
        self._manual = ManualController(
            self._sim.connection, self.network, self._clock, self._deadman_s
        )

    def close(self) -> None:
        if self._sim is not None:
            self._sim.close()
        self._sim = None
        self._manual = None

    def tick(self) -> EngineState:
        """Commands -> manual.step -> simulationStep -> observe -> state."""
        self._apply_commands()
        sim, manual = self._require()
        manual.step(STEP_LENGTH)
        snap = sim.step()
        manual.observe(snap.vehicle(AMBULANCE_ID), snap.time)
        state = EngineState(next(self._seq), "OFF", snap, manual.status(snap.time))
        self._latest = state
        return state

    def _require(self) -> tuple[SumoSimulation, ManualController]:
        if self._sim is None or self._manual is None:
            raise RuntimeError("engine is not open")
        return self._sim, self._manual

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
        sim, manual = self._require()
        match command:
            case Reset():
                self.close()
                self.open()
                return CommandResult(True, "simulation restarted")
            case SpawnAmbulance():
                spawn_ambulance(sim.connection, self.network, f"ambulance_{next(self._route_ids)}")
                manual.on_spawned(sim.snapshot().time)
                return CommandResult(True, "ambulance dispatched from the depot")
            case Drive(throttle=throttle, brake=brake):
                manual.set_drive(throttle, brake)
                return OK
            case Turn(direction=direction):
                return manual.request_turn(direction)
            case ChangeLane(direction=direction):
                return manual.request_lane(direction)

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

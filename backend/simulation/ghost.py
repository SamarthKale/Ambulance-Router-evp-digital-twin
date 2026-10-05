"""The OFF ghost (CLAUDE.md section 14): what the same mission would have taken with normal
signals and the autopilot, measured live, never estimated.

A shadow simulation runs in its own process from the moment the live one opens: same
scenario, seed and demand, warmed up the same way, stepped in lockstep with the live time,
with no ambulance. Nothing differs, so its traffic is the live traffic (the engine is
deterministic; tested). At the first dispatch it spawns its own ambulance at the same
simulated moment and drives it in OFF mode with the autopilot. Accidents injected live are
mirrored at the same moment. When the live ambulance arrives, the ghost runs ahead to its own
arrival and the difference is the time saved.

SUMO's saved states were tried for this and rejected: a run resumed from one diverged at once
(emergency braking, a junction collision), so the shadow replays instead.

Only the first dispatch since the simulation opened has an exact ghost: later ones follow a
history (manual driving, preemptions) the shadow can't reproduce.
"""

from __future__ import annotations

import logging
import multiprocessing as mp
from bisect import bisect_right
from dataclasses import dataclass, replace
from multiprocessing.connection import Connection as Pipe
from typing import Any, Literal

from simulation.sumo import STEP_LENGTH, SumoConfig
from simulation.vehicle import AMBULANCE_ID

log = logging.getLogger(__name__)

GhostPhase = Literal["shadowing", "driving", "arrived", "unavailable"]
FINISH_LIMIT_S = 1800.0  # after the live arrival the ghost gets this long to arrive
STOP_TIMEOUT_S = 5.0


@dataclass(frozen=True)
class GhostPose:
    t: float
    x: float
    y: float
    angle: float
    speed: float
    edge: str


@dataclass(frozen=True)
class GhostStatus:
    phase: GhostPhase
    pose: GhostPose | None = None  # the ghost ambulance at (or just before) the live time
    mission_time: float | None = None  # the ghost's, once it has arrived
    reason: str = ""  # why there is no ghost


# ---- the shadow process ----------------------------------------------------------------
def _shadow_main(pipe: Pipe, config: SumoConfig, warmup_s: float, routing: str) -> None:
    """Runs in the child process. Messages in: (kind, t, *args), each applied at simulated
    time t: 'advance', 'dispatch', 'accident' (edge), 'clear', 'finish', 'stop'."""
    from simulation.engine import (
        ClearIncidents,
        InjectAccident,
        SimulationEngine,
        SpawnAmbulance,
    )

    engine = SimulationEngine(
        config,
        realtime=False,
        deadman_s=None,
        mode="OFF",
        routing=routing,  # type: ignore[arg-type]
        control="autopilot",
        warmup_s=warmup_s,
    )
    try:
        engine.open()
        now = engine.time
        dispatched = arrived = False
        pose: GhostPose | None = None

        def tick() -> None:
            nonlocal now, pose, arrived
            state = engine.tick()
            now = state.snapshot.time
            vehicle = state.snapshot.vehicle(AMBULANCE_ID)
            if vehicle is not None:
                pose = GhostPose(
                    now, vehicle.x, vehicle.y, vehicle.angle, vehicle.speed, vehicle.edge
                )
            if dispatched and not arrived and state.ambulance.status == "arrived":
                arrived = True
                pipe.send(("arrived", now, state.ambulance.mission_time))

        def advance(t: float) -> None:
            while now < t - STEP_LENGTH / 2:
                tick()

        pipe.send(("ready", now))
        while True:
            messages = [pipe.recv()]
            while pipe.poll():
                messages.append(pipe.recv())
            for kind, t, *args in messages:
                if kind == "stop":
                    return
                if kind == "finish":  # the live mission ended: run ahead to the ghost's arrival
                    trajectory: list[GhostPose] = []
                    limit = now + FINISH_LIMIT_S
                    while dispatched and not arrived and now < limit:
                        tick()
                        if pose is not None:
                            trajectory.append(pose)
                    pipe.send(("trajectory", now, trajectory))
                    continue
                advance(t)
                if kind == "dispatch":
                    engine.submit(SpawnAmbulance())
                    dispatched = True
                elif kind == "accident":
                    engine.submit(InjectAccident(args[0]))
                elif kind == "clear":
                    engine.submit(ClearIncidents())
            pipe.send(("pose", now, pose if dispatched else None))
    except (EOFError, BrokenPipeError):
        pass  # the live engine went away
    except Exception as exc:  # report, then exit; the live run continues without a ghost
        try:
            pipe.send(("error", 0.0, f"{type(exc).__name__}: {exc}"))
        except (OSError, BrokenPipeError):
            pass
    finally:
        engine.close()


# ---- the live engine's handle ------------------------------------------------------------
class GhostRun:
    """Owned by the live engine thread. Never blocks on the shadow: it sends the live time
    every tick and reads whatever the shadow has answered so far."""

    def __init__(self, config: SumoConfig, warmup_s: float, routing: str) -> None:
        ghost_config = replace(config, log_path=config.log_path.with_name("sumo_ghost.log"))
        context = mp.get_context("spawn")
        self._pipe, child = context.Pipe()
        self._process = context.Process(
            target=_shadow_main,
            args=(child, ghost_config, warmup_s, routing),
            name="ef-ghost",
            daemon=True,
        )
        self._process.start()
        child.close()
        self.phase: GhostPhase = "shadowing"
        self.reason = ""
        self.mission_time: float | None = None
        self._pose: GhostPose | None = None
        self._trajectory: list[GhostPose] = []  # after "finish": ahead of the live time
        self._finished = False

    # engine thread -> shadow
    def advance(self, t: float) -> None:
        self._send(("advance", t))

    def dispatch(self, t: float) -> None:
        self.phase = "driving"
        self._send(("dispatch", t))

    def accident(self, t: float, edge: str) -> None:
        self._send(("accident", t, edge))

    def clear_accidents(self, t: float) -> None:
        self._send(("clear", t))

    def finish(self) -> None:
        if not self._finished and self.phase == "driving":
            self._finished = True
            self._send(("finish", 0.0))

    def stop(self) -> None:
        self._send(("stop", 0.0))
        self._process.join(STOP_TIMEOUT_S)
        if self._process.is_alive():
            self._process.kill()
            self._process.join(STOP_TIMEOUT_S)
        self._pipe.close()

    def unavailable(self, reason: str) -> None:
        self.phase, self.reason = "unavailable", reason
        self._pose = None
        self._trajectory = []

    def retire(self, reason: str) -> None:
        """No exact ghost for this mission: say why, and free the shadow's CPU."""
        self.unavailable(reason)
        self.stop()

    # shadow -> engine thread
    def status(self, live_t: float) -> GhostStatus:
        self._receive()
        if self.phase == "unavailable":
            return GhostStatus("unavailable", reason=self.reason)
        pose = self._pose
        if self._trajectory:  # the ghost ran ahead: show where it was at the live time
            i = bisect_right([p.t for p in self._trajectory], live_t + 1e-6)
            if i > 0:
                pose = self._trajectory[i - 1]
        if pose is not None and pose.t > live_t + 1e-6:
            pose = None
        return GhostStatus(self.phase, pose, self.mission_time)

    def _receive(self) -> None:
        try:
            while self._pipe.poll():
                kind, _, *args = self._pipe.recv()
                self._handle(kind, args)
        except (EOFError, OSError):
            if self.phase != "unavailable":
                self.unavailable("the ghost simulation stopped")

    def _handle(self, kind: str, args: list[Any]) -> None:
        if kind == "pose":
            self._pose = args[0]
        elif kind == "arrived":
            self.phase, self.mission_time = "arrived", args[0]
        elif kind == "trajectory":
            self._trajectory = args[0]
            if self.phase != "arrived":
                self.unavailable("the ghost did not arrive in time")
        elif kind == "error":
            log.warning("ghost simulation failed: %s", args[0])
            self.unavailable(f"ghost failed: {args[0]}")

    def _send(self, message: tuple[Any, ...]) -> None:
        try:
            self._pipe.send(message)
        except (OSError, BrokenPipeError):
            if self.phase != "unavailable":
                self.unavailable("the ghost simulation stopped")

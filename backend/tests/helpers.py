"""Helpers for tests that drive the engine synchronously against real SUMO."""

from __future__ import annotations

from collections.abc import Callable

import pytest

from simulation.engine import Command, EngineState, SimulationEngine, SpawnAmbulance
from simulation.manual_control import CommandResult
from simulation.sumo import STEP_LENGTH, VehicleState
from simulation.vehicle import AMBULANCE_ID


def command(engine: SimulationEngine, cmd: Command) -> CommandResult:
    future = engine.submit(cmd)
    engine.tick()
    return future.result(timeout=0)


def run_until(
    engine: SimulationEngine, seconds: float, until: Callable[[EngineState], bool]
) -> EngineState | None:
    for _ in range(round(seconds / STEP_LENGTH)):
        state = engine.tick()
        if until(state):
            return state
    return None


def run(
    engine: SimulationEngine,
    seconds: float,
    until: Callable[[EngineState], bool] | None = None,
) -> EngineState:
    if until is None:
        for _ in range(round(seconds / STEP_LENGTH)):
            state = engine.tick()
        return state
    reached = run_until(engine, seconds, until)
    if reached is None:
        pytest.fail(f"condition not reached within {seconds} s")
    return reached


def amb(state: EngineState) -> VehicleState:
    vehicle = state.snapshot.vehicle(AMBULANCE_ID)
    assert vehicle is not None, "ambulance not on the road"
    return vehicle


def on_edge(edge: str) -> Callable[[EngineState], bool]:
    def check(state: EngineState) -> bool:
        vehicle = state.snapshot.vehicle(AMBULANCE_ID)
        return vehicle is not None and vehicle.edge == edge

    return check


def spawn(engine: SimulationEngine) -> EngineState:
    assert command(engine, SpawnAmbulance()).ok
    return run(engine, 5, until=lambda s: s.ambulance.status == "driving")


def signal(state: EngineState, tls_id: str) -> str:
    return next(s.state for s in state.snapshot.signals if s.tls_id == tls_id)

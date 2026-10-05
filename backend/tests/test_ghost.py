"""Sprint 9: the OFF ghost of a live mission (real SUMO, 2x2, a shadow process per engine).

The shadow replays the live simulation exactly until the dispatch, so a live run driven like
the ghost (OFF, autopilot) must take exactly the ghost's time: time saved 0.0.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from api.protocol import state_message
from simulation.engine import (
    Control,
    EngineState,
    InjectAccident,
    Mode,
    Reset,
    SimulationEngine,
    SpawnAmbulance,
)
from simulation.sumo import STEP_LENGTH, SumoConfig
from tests.helpers import command, run

AMB = "ambulance_01"


def make_engine(tmp_path: Path, mode: Mode, control: Control = "autopilot") -> SimulationEngine:
    engine = SimulationEngine(
        SumoConfig(log_path=tmp_path / "sumo.log"),
        realtime=False,
        deadman_s=None,
        mode=mode,
        control=control,
        warmup_s=20,
        ghost=True,
    )
    engine.open()
    return engine


@pytest.fixture
def off(tmp_path: Path) -> Iterator[SimulationEngine]:
    engine = make_engine(tmp_path, "OFF")
    yield engine
    engine.close()


def until_saved(engine: SimulationEngine, live: dict[float, tuple[float, float]]) -> EngineState:
    """Tick (giving the shadow process time to keep up) until the time saved is measured."""
    for _ in range(round(400 / STEP_LENGTH)):
        state = engine.tick()
        vehicle = state.snapshot.vehicle(AMB)
        if vehicle is not None:
            live[round(state.snapshot.time, 1)] = (vehicle.x, vehicle.y)
        if state.time_saved_s is not None:
            return state
        time.sleep(0.001)
    pytest.fail("the ghost never reported")


def test_a_live_run_driven_like_the_ghost_takes_exactly_its_time(off: SimulationEngine) -> None:
    run(off, 2)
    assert off.latest is not None and off.latest.ghost is None  # shadowing: nothing to show
    assert command(off, SpawnAmbulance()).ok
    live: dict[float, tuple[float, float]] = {}
    poses = []
    for _ in range(300):
        state = off.tick()
        vehicle = state.snapshot.vehicle(AMB)
        if vehicle is not None:
            live[round(state.snapshot.time, 1)] = (vehicle.x, vehicle.y)
        if state.ghost is not None and state.ghost.pose is not None:
            poses.append(state.ghost.pose)
            assert state.ghost.pose.t <= state.snapshot.time + 1e-6  # never ahead of live
        time.sleep(0.002)
    assert len(poses) > 50
    for pose in poses:  # the same traffic, the same ambulance: the same positions
        assert (pose.x, pose.y) == pytest.approx(live[round(pose.t, 1)], abs=1e-6)
    done = until_saved(off, live)
    assert done.time_saved_s == 0.0
    assert done.ghost is not None and done.ghost.phase == "arrived"
    assert done.ghost.mission_time == done.ambulance.mission_time
    msg = state_message(done).model_dump(mode="json")
    assert msg["metrics"]["timeSaved"] == 0.0 and msg["ghost"]["phase"] == "arrived"


def test_the_ghost_meets_the_same_accident(off: SimulationEngine) -> None:
    assert command(off, SpawnAmbulance()).ok
    first = run(off, 1)
    assert first.route is not None
    blocked = first.route.edges[1]  # on the way: both must go round it
    assert command(off, InjectAccident(blocked)).ok
    done = until_saved(off, {})
    assert done.time_saved_s == 0.0


def test_preemption_saves_measured_time_against_the_off_ghost(tmp_path: Path) -> None:
    engine = make_engine(tmp_path, "BASIC")
    try:
        assert command(engine, SpawnAmbulance()).ok
        done = until_saved(engine, {})
        assert done.ghost is not None and done.ghost.mission_time is not None
        assert done.ambulance.mission_time is not None
        assert done.time_saved_s == pytest.approx(
            done.ghost.mission_time - done.ambulance.mission_time, abs=0.11
        )
        assert done.time_saved_s is not None and done.time_saved_s > 0
    finally:
        engine.close()


def test_only_the_first_dispatch_after_a_reset_has_a_ghost(off: SimulationEngine) -> None:
    assert command(off, SpawnAmbulance()).ok
    run(off, 3)
    assert command(off, SpawnAmbulance()).ok  # a second mission: history the shadow lacks
    state = run(off, 0.5)
    assert state.ghost is not None and state.ghost.phase == "unavailable"
    assert "Reset" in state.ghost.reason and state.time_saved_s is None
    assert state_message(state).model_dump(mode="json")["ghost"]["reason"]

    assert command(off, Reset()).ok  # a fresh simulation, a fresh shadow
    state = run(off, 1)
    assert state.ghost is None
    assert command(off, SpawnAmbulance()).ok
    assert until_saved(off, {}).time_saved_s == 0.0

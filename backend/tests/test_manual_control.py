"""Sprint 2: manual ambulance control against real SUMO, through the engine's command path.

Scenario facts used here (scenarios/grid2x2): the depot is the start of w0_A0 (eastbound
into A0, curb lane 0 = north side). A0 is red for that approach from 0 to 37 s.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from simulation.engine import (
    ChangeLane,
    Command,
    Drive,
    EngineState,
    Reset,
    SimulationEngine,
    SpawnAmbulance,
    Turn,
)
from simulation.manual_control import CommandResult
from simulation.sumo import STEP_LENGTH, SumoConfig, VehicleState
from simulation.vehicle import AMBULANCE_ID


@pytest.fixture
def engine(tmp_path: Path) -> Iterator[SimulationEngine]:
    eng = SimulationEngine(
        SumoConfig(log_path=tmp_path / "sumo.log"), realtime=False, deadman_s=None
    )
    eng.open()
    yield eng
    eng.close()


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


def test_spawns_at_depot_in_curb_lane_planning_straight(engine: SimulationEngine) -> None:
    state = spawn(engine)
    vehicle = amb(state)
    assert (vehicle.edge, vehicle.lane, vehicle.speed) == ("w0_A0", 0, 0.0)
    assert vehicle.y > 200.0  # eastbound curb lane is north of the centre line (left-hand)
    planned = state.ambulance.planned_turn
    assert planned is not None and (planned.junction, planned.turn, planned.edge) == (
        "A0",
        "straight",
        "A0_B0",
    )


def test_reaches_speed_cap_then_waits_at_red(engine: SimulationEngine) -> None:
    spawn(engine)
    command(engine, Drive(throttle=1, brake=0))
    speeds: list[float] = []
    prev: EngineState | None = None

    def entered_junction(state: EngineState) -> bool:
        nonlocal prev
        vehicle = amb(state)
        speeds.append(vehicle.speed)
        if vehicle.edge != "w0_A0":
            return True
        prev = state
        return False

    run(engine, 90, until=entered_junction)
    assert max(speeds) == pytest.approx(22.0, abs=0.05)
    assert max(speeds) <= 22.0 + 1e-6
    assert min(speeds[len(speeds) // 2 :]) < 0.1, "never stopped at the red light"
    assert prev is not None and prev.ambulance.next_signal is not None
    assert prev.ambulance.next_signal.state in "Gg", "entered the junction without green"


def test_brake_stops_within_physics(engine: SimulationEngine) -> None:
    spawn(engine)
    command(engine, Drive(throttle=1, brake=0))
    state = run(engine, 4)
    v0 = amb(state).speed
    assert v0 > 10
    command(engine, Drive(throttle=0, brake=1))
    run(engine, v0 / 6.0 + 0.5, until=lambda s: amb(s).speed < 0.01)


def test_deadman_zeroes_input_after_half_a_second(tmp_path: Path) -> None:
    now = [0.0]
    eng = SimulationEngine(
        SumoConfig(log_path=tmp_path / "sumo.log"), realtime=False, clock=lambda: now[0]
    )
    eng.open()
    try:
        spawn(eng)
        command(eng, Drive(throttle=1, brake=0))  # last drive message at clock 0.0
        throttle_seen: list[tuple[float, float]] = []
        for _ in range(20):
            now[0] += STEP_LENGTH
            state = eng.tick()
            throttle_seen.append((round(now[0], 1), state.ambulance.throttle))
        assert dict(throttle_seen)[0.4] == 1.0
        assert dict(throttle_seen)[0.7] == 0.0
    finally:
        eng.close()


@pytest.mark.parametrize(
    ("direction", "expected_edge", "turn"),
    [(None, "A0_B0", "straight"), ("left", "A0_A1", "left"), ("right", "A0_sA", "right")],
)
def test_turn_choice_at_next_junction(
    engine: SimulationEngine, direction: str | None, expected_edge: str, turn: str
) -> None:
    spawn(engine)
    if direction is not None:
        result = command(engine, Turn(direction))  # type: ignore[arg-type]
        assert result.ok, result.reason
    state = engine.tick()
    planned = state.ambulance.planned_turn
    assert planned is not None and (planned.turn, planned.edge) == (turn, expected_edge)
    command(engine, Drive(throttle=1, brake=0))
    run(engine, 150, until=on_edge(expected_edge))


def test_turn_pressed_inside_junction_is_queued_for_the_next(engine: SimulationEngine) -> None:
    spawn(engine)
    command(engine, Drive(throttle=1, brake=0))
    run(engine, 90, until=lambda s: amb(s).edge.startswith(":A0"))
    result = command(engine, Turn("left"))
    assert result.ok and "queued for B0" in result.reason
    state = run(engine, 30, until=on_edge("A0_B0"))
    planned = state.ambulance.planned_turn
    assert planned is not None and (planned.junction, planned.turn, planned.edge) == (
        "B0",
        "left",
        "B0_B1",
    )
    assert state.ambulance.queued_turn is None


def change_lane(engine: SimulationEngine, direction: str, lane: int) -> EngineState:
    """Press Q/E until the lane change happens, like a driver would (traffic may block it)."""
    for _ in range(8):
        result = command(engine, ChangeLane(direction))  # type: ignore[arg-type]
        assert result.ok, result.reason
        reached = run_until(engine, 3.0, lambda s: amb(s).lane == lane)
        if reached is not None:
            return run(engine, 2)  # let the 1.5 s lateral movement finish
    pytest.fail(f"never reached lane {lane}")


def test_lane_keys_follow_left_hand_traffic(engine: SimulationEngine) -> None:
    spawn(engine)
    command(engine, Drive(throttle=0.3, brake=0))
    run(engine, 2)
    rejected = command(engine, ChangeLane("left"))
    assert not rejected.ok and "no lane further left" in rejected.reason

    y_curb = amb(engine.tick()).y
    y_inner = amb(change_lane(engine, "right", lane=1)).y
    assert y_inner < y_curb - 2.5  # eastbound: right = south = towards the centre line
    assert amb(change_lane(engine, "left", lane=0)).y == pytest.approx(y_curb, abs=0.2)


def test_u_turn_at_the_map_edge(engine: SimulationEngine) -> None:
    spawn(engine)
    assert command(engine, Turn("right")).ok
    command(engine, Drive(throttle=1, brake=0))
    state = run(engine, 150, until=on_edge("A0_sA"))
    planned = state.ambulance.planned_turn
    assert planned is not None and (planned.junction, planned.turn) == ("sA", "uturn")
    rejected = command(engine, Turn("left"))
    assert not rejected.ok and rejected.reason == "no left turn at sA"
    run(engine, 60, until=on_edge("sA_A0"))


def test_infeasible_requests_are_rejected_with_a_reason(engine: SimulationEngine) -> None:
    no_ambulance = command(engine, Turn("left"))
    assert not no_ambulance.ok and no_ambulance.reason == "no ambulance on the road"

    spawn(engine)
    command(engine, Drive(throttle=1, brake=0))
    # Waiting at A0's red light, in the curb lane, right at the stop line.
    state = run(
        engine,
        60,
        until=lambda s: amb(s).speed < 0.01
        and s.ambulance.next_signal is not None
        and s.ambulance.next_signal.distance < 10,
    )
    assert amb(state).lane == 0
    too_late = command(engine, Turn("right"))  # the right turn needs the inner lane
    assert not too_late.ok and too_late.reason.startswith("too late to turn right at A0")
    planned = engine.tick().ambulance.planned_turn
    assert planned is not None and planned.turn == "straight"  # plan unchanged


def test_drive_to_hospital_and_park(engine: SimulationEngine) -> None:
    spawn(engine)
    command(engine, Drive(throttle=1, brake=0))
    run(engine, 120, until=on_edge("A0_B0"))
    assert command(engine, Turn("left")).ok  # B0: north
    run(engine, 120, until=on_edge("B0_B1"))
    assert command(engine, Turn("right")).ok  # B1: east, onto the hospital road
    state = run(engine, 150, until=lambda s: s.ambulance.status == "arrived")
    vehicle = amb(state)
    hospital = engine.network.hospital
    assert vehicle.edge == hospital.edge and vehicle.speed == 0.0
    assert abs(vehicle.x - hospital.x) < 8.0 and abs(vehicle.y - hospital.y) < 4.0
    mission = state.ambulance.mission_time
    assert mission is not None and mission > 30
    later = run(engine, 5)
    assert later.ambulance.mission_time == mission  # frozen on arrival
    refused = command(engine, Turn("left"))
    assert not refused.ok and "arrived" in refused.reason


def test_spawn_again_returns_to_depot(engine: SimulationEngine) -> None:
    spawn(engine)
    command(engine, Drive(throttle=1, brake=0))
    run(engine, 5)
    state = spawn(engine)
    vehicle = amb(state)
    assert vehicle.edge == "w0_A0" and vehicle.speed == 0.0
    assert state.ambulance.mission_time is not None and state.ambulance.mission_time < 1.0


def test_reset_restarts_the_simulation(engine: SimulationEngine) -> None:
    spawn(engine)
    run(engine, 3)
    result = command(engine, Reset())
    assert result.ok
    state = engine.tick()
    assert state.snapshot.time == pytest.approx(2 * STEP_LENGTH)
    assert state.ambulance.status == "none"
    assert state.snapshot.vehicle(AMBULANCE_ID) is None

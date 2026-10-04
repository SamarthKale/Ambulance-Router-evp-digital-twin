"""Sprint 3: BASIC preemption end to end against real SUMO, through the safety controller.

Seed 42, scenarios/grid2x2. The ambulance starts at the depot (start of w0_A0, eastbound
into A0). Under the normal program the west approach is red at A0 from 0 to 37 s.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from pathlib import Path

import pytest

from ai.rules import AmbulanceView, RuleAction, basic_preemption
from safety.controller import MAX_PREEMPT_S
from scripts.smoke_compare import run_mission
from simulation.engine import Drive, EngineState, SetMode, SimulationEngine
from simulation.sumo import SumoConfig
from tests.helpers import amb, command, on_edge, run, signal, spawn

NS_GREEN = "GGGgrrrrGGGgrrrr"  # A0 phase 0: the cross direction for an eastbound ambulance


@pytest.fixture
def basic(tmp_path: Path) -> Iterator[SimulationEngine]:
    eng = SimulationEngine(
        SumoConfig(log_path=tmp_path / "sumo.log"), realtime=False, deadman_s=None, mode="BASIC"
    )
    eng.open()
    yield eng
    eng.close()


def a0_actions(state: EngineState) -> list[str]:
    return [e.action for e in state.safety.events if e.junction == "A0"]


def test_ambulance_crosses_without_stopping_and_signal_recovers(basic: SimulationEngine) -> None:
    spawn(basic)
    command(basic, Drive(throttle=1, brake=0))
    speeds: list[float] = []

    def entered_a0(state: EngineState) -> bool:
        vehicle = amb(state)
        if vehicle.edge == "w0_A0":
            speeds.append(vehicle.speed)
        return vehicle.edge.startswith(":A0")

    entered = run(basic, 30, until=entered_a0)
    assert entered.snapshot.time < 15.0  # in OFF it waits for green until ~37 s
    top = speeds.index(max(speeds))
    assert min(speeds[top:]) > 21.5, "slowed down on the approach"
    assert entered.ambulance.next_signal is None or entered.snapshot.time > 0

    after = run(basic, 10, until=lambda s: s.safety.stages["A0"] == "program")
    assert signal(after, "A0") == NS_GREEN  # recovered to the other direction's green
    assert a0_actions(after) == ["preempt", "green", "release", "resume"]
    assert after.safety.violations == 0 and after.safety.collisions == 0
    assert after.safety.signals_preempted >= 1


def test_preemption_times_out_after_40_s(basic: SimulationEngine) -> None:
    spawn(basic)
    command(basic, Drive(throttle=1, brake=0))
    accepted = run(basic, 20, until=lambda s: s.safety.stages["A0"] != "program")
    command(basic, Drive(throttle=0, brake=1))  # stop far from the junction and wait
    stopped = run(basic, 10, until=lambda s: amb(s).speed == 0.0)
    assert amb(stopped).edge == "w0_A0"
    t_accept = next(e.time for e in accepted.safety.events if e.action == "preempt")

    timed_out = run(basic, MAX_PREEMPT_S + 5, until=lambda s: "timeout" in a0_actions(s))
    assert timed_out.snapshot.time == pytest.approx(t_accept + MAX_PREEMPT_S, abs=0.15)
    back = run(basic, 10, until=lambda s: s.safety.stages["A0"] == "program")
    assert signal(back, "A0") == NS_GREEN
    assert back.safety.violations == 0


def test_switching_to_off_releases_the_junction(basic: SimulationEngine) -> None:
    spawn(basic)
    command(basic, Drive(throttle=1, brake=0))
    run(basic, 20, until=lambda s: s.safety.stages["A0"] == "preempted")
    result = command(basic, SetMode("OFF"))
    assert result.ok and basic.mode == "OFF"
    back = run(basic, 10, until=lambda s: s.safety.stages["A0"] == "program")
    release = next(e for e in back.safety.events if e.action == "release")
    assert release.reason == "mode switched to OFF"
    assert back.safety.violations == 0
    coord = command(basic, SetMode("COORD"))
    assert not coord.ok and "Sprint 7" in coord.reason


def test_rule_failure_falls_back_to_normal_programs(tmp_path: Path) -> None:
    def flaky_rule(view: AmbulanceView | None, held: Iterable[str]) -> list[RuleAction]:
        held = list(held)
        if held:
            raise RuntimeError("simulated decision-logic bug")
        return basic_preemption(view, held)

    eng = SimulationEngine(
        SumoConfig(log_path=tmp_path / "sumo.log"),
        realtime=False,
        deadman_s=None,
        mode="BASIC",
        rule=flaky_rule,
    )
    eng.open()
    try:
        spawn(eng)
        command(eng, Drive(throttle=1, brake=0))
        failed = run(eng, 20, until=lambda s: s.mode == "OFF")
        fail_safe = next(e for e in failed.safety.events if e.action == "fail_safe")
        assert "simulated decision-logic bug" in fail_safe.reason
        back = run(eng, 10, until=lambda s: s.safety.stages["A0"] == "program")
        assert back.safety.violations == 0
    finally:
        eng.close()


def test_mission_to_the_hospital_off_vs_basic_seed_42() -> None:
    """Single-seed smoke comparison (not the evaluation): BASIC must not stop at signals."""
    off = run_mission("OFF", seed=42)
    basic = run_mission("BASIC", seed=42)
    assert off.mission_time is not None and basic.mission_time is not None
    assert basic.mission_time < off.mission_time
    assert basic.stops == 0 and off.stops > 0
    assert basic.preemptions == 3  # A0, B0, B1
    for result in (off, basic):
        assert result.violations == 0 and result.collisions == 0


def test_ambulance_reaches_the_next_junction_on_its_preempted_green(
    basic: SimulationEngine,
) -> None:
    spawn(basic)
    command(basic, Drive(throttle=1, brake=0))
    run(basic, 30, until=on_edge("A0_B0"))
    at_b0 = run(basic, 30, until=lambda s: amb(s).edge.startswith(":B0"))
    assert at_b0.safety.stages["B0"] == "preempted"
    assert at_b0.safety.violations == 0

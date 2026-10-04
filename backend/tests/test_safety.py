"""Sprint 3: safety controller and rules, pure (no SUMO). CLAUDE.md section 8.

Uses junction A0 of scenarios/grid2x2: 16 links, approaches sA_A0 (0-3), B0_A0 (4-7),
A1_A0 (8-11), w0_A0 (12-15); normal program phase 0 = north-south green, phase 3 = east-west.
"""

from __future__ import annotations

import dataclasses

import pytest

from safety.controller import (
    MAX_PREEMPT_S,
    MIN_CROSS_GREEN_S,
    ResumeProgram,
    SafetyController,
    SetSignalState,
    transition,
)
from safety.invariants import SignalChecker
from safety.signal_table import SignalTable
from simulation.sumo import SumoConfig
from simulation.traffic_lights import load_signal_tables

NS_GREEN, NS_YELLOW, ALL_RED, EW_GREEN = (
    "GGGgrrrrGGGgrrrr",
    "yyyyrrrryyyyrrrr",
    "rrrrrrrrrrrrrrrr",
    "rrrrGGGgrrrrGGGg",
)
WEST_ONLY = "rrrrrrrrrrrrGGGG"
WEST_LINK = 13  # w0_A0 straight


@pytest.fixture(scope="module")
def tables() -> dict[str, SignalTable]:
    return load_signal_tables(SumoConfig().net_path)


@pytest.fixture
def a0(tables: dict[str, SignalTable]) -> SignalTable:
    return tables["A0"]


def run(controller: SafetyController, start: float, end: float) -> list[tuple[float, object]]:
    """Step the controller every 0.1 s; return (time, actuation) pairs."""
    out = []
    t = start
    while t <= end + 1e-9:
        out += [(round(t, 1), a) for a in controller.step(round(t, 1))]
        t += 0.1
    return out


def preempt(controller: SafetyController, now: float, state: str, vehicle_class: str = "emergency"):
    return controller.request_preempt(now, "A0", WEST_LINK, "amb", vehicle_class, state, 12.0)


# ---- tables -------------------------------------------------------------------------
def test_tables_have_symmetric_conflicts_and_approaches(tables: dict[str, SignalTable]) -> None:
    assert sorted(tables) == ["A0", "A1", "B0", "B1"]
    for table in tables.values():
        assert table.link_count == 16
        for i in range(16):
            for j in table.foes[i]:
                assert i in table.foes[j]
    a0 = tables["A0"]
    assert a0.approach_links("w0_A0") == frozenset({12, 13, 14, 15})
    assert a0.foes[0] == frozenset({5, 6})  # northbound left (curb side) merges with westbound
    assert a0.approach_exclusive_state("w0_A0") == WEST_ONLY


def test_normal_program_is_clean(tables: dict[str, SignalTable]) -> None:
    for table in tables.values():
        checker = SignalChecker(table)
        t, violations = 0.0, []
        for _ in range(3):
            for state, duration in table.phases:
                violations += checker.observe(t, state)
                t += duration
        assert violations == [], table.tls_id


def test_recovery_phase_is_the_other_directions_green(a0: SignalTable) -> None:
    assert a0.phases[a0.recovery_phase("w0_A0")][0] == NS_GREEN
    assert a0.phases[a0.recovery_phase("sA_A0")][0] == EW_GREEN


# ---- rules (also what the monitor checks) ----------------------------------------------
def observe(table: SignalTable, sequence: list[tuple[float, str]]) -> list[str]:
    checker = SignalChecker(table)
    return [v.rule for t, s in sequence for v in checker.observe(t, s)]


def test_r1_conflicting_greens(a0: SignalTable) -> None:
    both = "G" + "r" * 4 + "G" + "r" * 10  # links 0 and 5 conflict
    assert observe(a0, [(0.0, both)]) == ["R1"]


def test_r2_green_needs_yellow_of_four_seconds(a0: SignalTable) -> None:
    assert "R2" in observe(a0, [(0.0, NS_GREEN), (10.0, ALL_RED)])  # no yellow
    assert "R2" in observe(a0, [(0.0, NS_GREEN), (10.0, NS_YELLOW), (13.0, ALL_RED)])  # 3 s
    assert "R2" in observe(a0, [(0.0, NS_GREEN), (10.0, NS_YELLOW), (11.0, NS_GREEN)])  # y->G
    assert observe(a0, [(0.0, NS_GREEN), (10.0, NS_YELLOW), (14.0, ALL_RED)]) == []


def test_r3_all_red_of_two_seconds_before_conflicting_green(a0: SignalTable) -> None:
    seq = [(0.0, NS_GREEN), (10.0, NS_YELLOW), (14.0, ALL_RED), (15.0, EW_GREEN)]
    assert "R3" in observe(a0, seq)  # only 1 s all-red
    seq[-1] = (16.0, EW_GREEN)
    assert observe(a0, seq) == []


# ---- controller ---------------------------------------------------------------------
def test_only_emergency_vehicles_may_preempt(tables: dict[str, SignalTable]) -> None:
    controller = SafetyController(tables)
    decision = preempt(controller, 0.0, NS_GREEN, vehicle_class="passenger")
    assert not decision.accepted and "passenger" in decision.reason
    assert controller.stage("A0") == "program"
    event = controller.events[-1]
    assert (event.action, event.accepted) == ("preempt", False) and event.reason


def test_clearing_respects_yellow_and_all_red(tables: dict[str, SignalTable]) -> None:
    controller = SafetyController(tables)
    decision = preempt(controller, 10.0, NS_GREEN)
    assert decision.accepted
    assert controller.stage("A0") == "clearing"
    actions = run(controller, 10.0, 20.0)
    assert actions == [
        (10.0, SetSignalState("A0", NS_YELLOW)),
        (14.0, SetSignalState("A0", ALL_RED)),
        (16.0, SetSignalState("A0", WEST_ONLY)),
    ]
    assert controller.stage("A0") == "preempted"
    assert controller.signals_preempted == 1


def test_approach_already_green_keeps_its_green(tables: dict[str, SignalTable]) -> None:
    controller = SafetyController(tables)
    preempt(controller, 0.0, EW_GREEN)
    states = [a.state for _, a in run(controller, 0.0, 10.0) if isinstance(a, SetSignalState)]
    assert states == [
        "rrrryyyyrrrrGGGg",  # only the east approach clears; west keeps moving
        "rrrrrrrrrrrrGGGg",
        WEST_ONLY,  # west's crossing right turn becomes protected after the all-red
    ]


def test_release_recovers_to_the_other_directions_green(tables: dict[str, SignalTable]) -> None:
    controller = SafetyController(tables)
    preempt(controller, 0.0, NS_GREEN)
    run(controller, 0.0, 8.0)
    assert controller.request_release(9.0, "A0", "amb", "ambulance cleared A0").accepted
    assert controller.stage("A0") == "recovering"
    actions = run(controller, 9.0, 20.0)
    assert actions == [
        (9.0, SetSignalState("A0", "rrrrrrrrrrrryyyy")),
        (13.0, SetSignalState("A0", ALL_RED)),
        (15.0, ResumeProgram("A0", "0", 0)),  # phase 0 = north-south green
    ]
    assert controller.stage("A0") == "program"
    assert [e.action for e in controller.events] == ["preempt", "green", "release", "resume"]


def test_preemption_times_out_after_40_seconds(tables: dict[str, SignalTable]) -> None:
    controller = SafetyController(tables)
    preempt(controller, 0.0, NS_GREEN)
    run(controller, 0.0, MAX_PREEMPT_S - 0.1)
    assert controller.stage("A0") == "preempted"
    actions = run(controller, MAX_PREEMPT_S, MAX_PREEMPT_S + 0.05)
    assert actions == [(MAX_PREEMPT_S, SetSignalState("A0", "rrrrrrrrrrrryyyy"))]
    assert controller.stage("A0") == "recovering"
    timeout = next(e for e in controller.events if e.action == "timeout")
    assert "40 s" in timeout.reason


def test_cross_traffic_keeps_green_after_recovery(tables: dict[str, SignalTable]) -> None:
    controller = SafetyController(tables)
    preempt(controller, 0.0, NS_GREEN)
    run(controller, 0.0, 8.0)
    controller.request_release(9.0, "A0", "amb", "cleared")
    run(controller, 9.0, 15.0)  # resumed at 15.0
    early = preempt(controller, 15.0 + MIN_CROSS_GREEN_S - 1, NS_GREEN)
    assert not early.accepted and early.code == "cooldown"
    assert preempt(controller, 15.0 + MIN_CROSS_GREEN_S, NS_GREEN).accepted


def test_busy_recovering_and_duplicate_requests(tables: dict[str, SignalTable]) -> None:
    controller = SafetyController(tables)
    preempt(controller, 0.0, NS_GREEN)
    logged = len(controller.events)
    assert preempt(controller, 1.0, NS_GREEN).code == "duplicate"
    assert len(controller.events) == logged  # duplicates are not re-logged
    other = controller.request_preempt(1.0, "A0", 1, "fire_02", "emergency", NS_GREEN, 5.0)
    assert not other.accepted and other.code == "busy"
    run(controller, 0.0, 7.0)
    controller.request_release(8.0, "A0", "amb", "cleared")
    again = preempt(controller, 8.5, NS_GREEN)
    assert not again.accepted and again.code == "recovering"


def test_repeated_rejections_are_logged_once(tables: dict[str, SignalTable]) -> None:
    controller = SafetyController(tables)
    for t in range(5):
        preempt(controller, float(t), NS_GREEN, vehicle_class="passenger")
    assert len(controller.events) == 1


def test_release_all_recovers_every_preempted_junction(tables: dict[str, SignalTable]) -> None:
    controller = SafetyController(tables)
    preempt(controller, 0.0, NS_GREEN)
    controller.request_preempt(0.0, "B1", 13, "amb", "emergency", NS_GREEN, 9.0)
    run(controller, 0.0, 7.0)
    controller.release_all(8.0, "decision logic failed", action="fail_safe")
    assert controller.stages() == {
        "A0": "recovering",
        "A1": "program",
        "B0": "program",
        "B1": "recovering",
    }
    assert [e.action for e in controller.events][-2:] == ["fail_safe", "fail_safe"]


def test_unsafe_target_is_rejected(a0: SignalTable) -> None:
    # Corrupt the table so the west approach's own links conflict: its exclusive green
    # would then be unsafe and must be refused rather than applied.
    foes = list(a0.foes)
    foes[12], foes[13] = foes[12] | {13}, foes[13] | {12}
    broken = dataclasses.replace(a0, foes=tuple(foes))
    controller = SafetyController({"A0": broken})
    decision = preempt(controller, 0.0, NS_GREEN)
    assert not decision.accepted and decision.code == "unsafe"
    assert controller.stage("A0") == "program"


@pytest.mark.parametrize("start", [NS_GREEN, NS_YELLOW, ALL_RED, EW_GREEN, "rrrryyyyrrrryyyy"])
def test_whole_preemption_cycle_passes_the_monitor_rules(a0: SignalTable, start: str) -> None:
    """Replay every emitted state through the monitor's rules, from any program state."""
    controller = SafetyController({"A0": a0})
    checker = SignalChecker(a0)
    checker.prime(start, since=-100.0)
    shown = start
    violations = []
    preempt(controller, 0.0, start)
    for tick in range(0, 400):
        t = round(tick * 0.1, 1)
        if t == 20.0:
            controller.request_release(t, "A0", "amb", "cleared")
        for action in controller.step(t):
            shown = (
                action.state if isinstance(action, SetSignalState) else a0.phases[action.phase][0]
            )
        # what SUMO shows after the next step, observed at t + 0.1
        violations += checker.observe(round(t + 0.1, 1), shown)
    assert violations == []
    assert controller.stage("A0") == "program"


def test_transition_from_identical_state_is_a_no_op() -> None:
    assert transition(WEST_ONLY, WEST_ONLY) == [(WEST_ONLY, 0.0)]

"""Sprint 7: COORD rule (pure) and COORD missions against real SUMO through the controller."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from pathlib import Path

import pytest

from ai.coord import (
    MAX_LEAD_S,
    PREPARE_AHEAD,
    RELEASE_GRACE_S,
    CoordPreemption,
    Upcoming,
    lead_time_s,
)
from ai.rules import PREEMPT_LEAD_S, AmbulanceView, Preempt, Release, RuleAction
from simulation.engine import EngineState, SimulationEngine, SpawnAmbulance
from simulation.sumo import SumoConfig
from tests.helpers import run


def view(edge: str = "w0_A0", speed: float = 20.0, behind: str | None = "w0") -> AmbulanceView:
    return AmbulanceView("ambulance_01", "emergency", edge, speed, "A0", 13, 200.0, behind)


def ahead(*items: tuple[str, float, int]) -> list[Upcoming]:
    return [Upcoming(j, 13, f"x_{j}", d, q, 2) for j, d, q in items]


def test_lead_time_grows_with_the_queue_and_is_capped() -> None:
    assert lead_time_s(0, 2) == pytest.approx(6 + 2 + 3)  # clearance + start-up + margin
    assert lead_time_s(10, 2) == pytest.approx(6 + 2 + 10 + 3)  # 5 per lane x 2 s
    assert lead_time_s(1000, 2) == MAX_LEAD_S
    assert lead_time_s(0, 2) < PREEMPT_LEAD_S < lead_time_s(8, 2)


def test_empty_approach_is_preempted_later_than_basic_and_queued_earlier() -> None:
    rule = CoordPreemption()
    # 20 m/s: 260 m is ETA 13 s. Empty approach (lead 11 s): not yet. BASIC would (15 s).
    assert rule(view(), ahead(("A0", 260.0, 0)), [], 0.0) == []
    # same distance with 12 queued (lead 23 s): preempt now
    actions = rule(view(), ahead(("A0", 260.0, 12)), [], 0.0)
    assert len(actions) == 1 and isinstance(actions[0], Preempt)
    assert actions[0].junction == "A0" and "queue 12" in actions[0].note


def test_prepares_the_junctions_after_the_next_one() -> None:
    rule = CoordPreemption()
    # 20 m/s: A0 ETA 5 s; B0 ETA 17 s with lead 21 s; C0 ETA 32 s beyond the capped 30 s
    upcoming = ahead(("A0", 100.0, 0), ("B0", 340.0, 10), ("C0", 640.0, 30), ("D0", 400.0, 30))
    actions = rule(view(), upcoming, [], 0.0)
    preempted = {a.junction: a for a in actions if isinstance(a, Preempt)}
    assert set(preempted) == {"A0", "B0"}  # C0's 30 s ETA is beyond its capped lead
    assert "prepared ahead" in preempted["B0"].note
    assert "D0" not in preempted  # only PREPARE_AHEAD junctions are looked at
    assert PREPARE_AHEAD == 3


def test_releases_a_crossed_junction_at_once() -> None:
    rule = CoordPreemption()
    crossed = view(edge="A0_B0", behind="A0")
    assert rule(crossed, ahead(("B0", 900.0, 0)), ["A0"], 10.0) == [
        Release("A0", "ambulance cleared A0")
    ]


def test_keeps_a_junction_while_crossing_it_or_while_it_is_still_ahead() -> None:
    rule = CoordPreemption()
    inside = view(edge=":A0_13_0", behind=None)
    assert rule(inside, ahead(("B0", 900.0, 0)), ["A0"], 0.0) == []
    assert rule(view(), ahead(("A0", 900.0, 0), ("B0", 1200.0, 0)), ["B0"], 0.0) == []


def test_a_junction_off_the_route_is_given_back_after_a_grace() -> None:
    rule = CoordPreemption()
    off = ahead(("A0", 900.0, 0))  # B0 no longer on the route (plan flicker or a turn)
    assert rule(view(), off, ["B0"], 100.0) == []
    assert rule(view(), off, ["B0"], 100.0 + RELEASE_GRACE_S / 2) == []
    back = ahead(("A0", 900.0, 0), ("B0", 1200.0, 0))
    assert rule(view(), back, ["B0"], 100.0 + RELEASE_GRACE_S * 0.9) == []  # flicker over
    assert rule(view(), off, ["B0"], 200.0) == []  # the clock restarts
    assert rule(view(), off, ["B0"], 200.0 + RELEASE_GRACE_S) == [
        Release("B0", "B0 is no longer on the route")
    ]


def test_everything_is_released_when_the_ambulance_is_gone() -> None:
    assert CoordPreemption()(None, [], ["A0", "B0"], 0.0) == [
        Release("A0", "ambulance left the road"),
        Release("B0", "ambulance left the road"),
    ]


# ---- against SUMO ---------------------------------------------------------------------
def coord_engine(
    tmp_path: Path, config: SumoConfig | None = None, **kwargs: object
) -> SimulationEngine:
    engine = SimulationEngine(
        config or SumoConfig(log_path=tmp_path / "sumo.log"),
        realtime=False,
        deadman_s=None,
        mode="COORD",
        control="autopilot",
        **kwargs,  # type: ignore[arg-type]
    )
    engine.open()
    return engine


def test_coord_mission_prepares_junctions_ahead_safely(tmp_path: Path) -> None:
    """4x4 at 1.5x, seed 3, dispatched at 331 s: queues ahead make COORD prepare junctions
    beyond the next one (with no queues there is nothing to prepare)."""
    config = SumoConfig(scenario="grid4x4", seed=3, scale=1.5, log_path=tmp_path / "sumo.log")
    engine = coord_engine(tmp_path, config, warmup_s=331.0)
    try:
        engine.submit(SpawnAmbulance())
        accepted: list[str] = []

        def arrived(state: EngineState) -> bool:
            accepted.extend(
                e.reason
                for e in state.safety.events
                if e.action == "preempt" and e.accepted and e.reason not in accepted
            )
            return state.ambulance.status == "arrived"

        done = run(engine, 180, until=arrived)
        assert any("prepared ahead" in r for r in accepted), accepted
        assert all("queue" in r and "lead" in r for r in accepted)
        assert done.safety.violations == 0 and done.safety.collisions == 0
        assert done.safety.signals_preempted >= 3
    finally:
        engine.close()


def test_coord_rule_failure_falls_back_to_normal_programs(tmp_path: Path) -> None:
    class Broken:
        def __call__(
            self,
            view: AmbulanceView | None,
            upcoming: Sequence[Upcoming],
            held: Iterable[str],
            now: float,
        ) -> list[RuleAction]:
            raise RuntimeError("simulated COORD bug")

    engine = coord_engine(tmp_path, coord_rule=Broken)
    try:
        engine.submit(SpawnAmbulance())
        failed = run(engine, 20, until=lambda s: s.mode == "OFF")
        fail_safe = [e for e in failed.safety.events if e.action == "fail_safe"]
        assert failed.mode == "OFF"
        assert all("simulated COORD bug" in e.reason for e in fail_safe)
        assert failed.safety.violations == 0
    finally:
        engine.close()

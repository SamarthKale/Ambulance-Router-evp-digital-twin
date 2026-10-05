"""Sprint 6: routing inside the engine against real SUMO (grid2x2, seed 42).

Manual driving: the route is advisory (it never steers). Autopilot (batch only): it
follows the route, and every reroute passes the safety controller first.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from api.protocol import state_message
from simulation.engine import Control, Drive, EngineState, Routing, SimulationEngine, Turn
from simulation.sumo import SumoConfig
from tests.helpers import command, run, spawn

HOSPITAL = "B1_e1"


def make_engine(
    tmp_path: Path, control: Control = "manual", routing: Routing = "dynamic", mode: str = "BASIC"
) -> SimulationEngine:
    engine = SimulationEngine(
        SumoConfig(log_path=tmp_path / "sumo.log"),
        realtime=False,
        deadman_s=None,
        mode=mode,  # type: ignore[arg-type]
        control=control,
        routing=routing,
    )
    engine.open()
    return engine


@pytest.fixture
def manual(tmp_path: Path) -> Iterator[SimulationEngine]:
    engine = make_engine(tmp_path)
    yield engine
    engine.close()


def test_route_is_suggested_from_dispatch_and_never_steers(manual: SimulationEngine) -> None:
    state = spawn(manual)
    route = state.route
    assert route is not None
    assert route.edges[0] == "w0_A0" and route.edges[-1] == HOSPITAL
    assert route.distance_m == pytest.approx(822.6, abs=2.0)
    assert 35 < route.eta_s < 90
    assert route.turns[0].junction == "A0"
    # The default plan is straight on at A0; the suggestion turns there, so it isn't followed.
    assert route.turns[0].turn != "straight" and not route.follows
    assert state.ambulance.planned_turn is not None
    assert state.ambulance.planned_turn.edge == "A0_B0"  # the route did not steer it

    assert command(manual, Turn(route.turns[0].turn)).ok  # type: ignore[arg-type]
    followed = run(manual, 1, until=lambda s: s.route is not None and s.route.follows)
    assert followed.ambulance.planned_turn is not None
    assert followed.ambulance.planned_turn.edge == route.edges[1]


def test_eta_counts_down_and_replans_every_second(manual: SimulationEngine) -> None:
    spawn(manual)
    command(manual, Drive(throttle=1, brake=0))
    seen = [manual.tick() for _ in range(30)]  # 3 s
    plans = {s.route.plan.computed_at for s in seen if s.route is not None}
    assert len(plans) >= 3  # dynamic: re-planned at least once a second
    etas = [s.route.eta_s for s in seen if s.route is not None]
    assert etas[-1] < etas[0]


def test_route_is_published_in_camel_case(manual: SimulationEngine) -> None:
    state = spawn(manual)
    msg = state_message(state).model_dump(mode="json")
    route = msg["route"]
    assert route["edges"][-1] == HOSPITAL and route["routing"] == "dynamic"
    assert {"eta", "distance", "follows", "computedAt", "turns", "drive", "queue", "signal"} <= set(
        route
    )
    assert msg["metrics"]["eta"] == route["eta"]


def test_autopilot_follows_the_route_through_the_safety_controller(tmp_path: Path) -> None:
    engine = make_engine(tmp_path, control="autopilot")
    try:
        first = spawn(engine)
        assert first.route is not None
        predicted = first.route.eta_s + (first.ambulance.mission_time or 0.0)
        reroutes: list[str] = []

        def arrived(state: EngineState) -> bool:
            reroutes.extend(
                e.reason for e in state.safety.events if e.action == "reroute" and e.accepted
            )
            return state.ambulance.status == "arrived"

        done = run(engine, 180, until=arrived)
        actual = done.ambulance.mission_time
        assert actual is not None
        assert abs(actual - predicted) / actual < 0.15, (predicted, actual)
        assert reroutes, "the autopilot never asked the safety controller"
        assert done.safety.violations == 0 and done.safety.collisions == 0
    finally:
        engine.close()


def test_static_routing_keeps_the_dispatch_plan(tmp_path: Path) -> None:
    engine = make_engine(tmp_path, control="autopilot", routing="static")
    try:
        first = spawn(engine)
        assert first.route is not None and first.route.routing == "static"
        dispatch_plan = first.route.plan
        later = run(engine, 20, until=lambda s: s.route is not None and len(s.route.edges) < 4)
        assert later.route is not None and later.route.plan is dispatch_plan
        assert (
            later.route.edges
            == dispatch_plan.edges[len(dispatch_plan.edges) - len(later.route.edges) :]
        )
        # The autopilot steers the whole dispatch plan, not just its first junction (it once
        # went straight on at every later junction: the plan's first road was long behind).
        driven: list[str] = [e for e in dispatch_plan.edges[:1]]

        def arrived(state: EngineState) -> bool:
            vehicle = state.snapshot.vehicle("ambulance_01")
            if vehicle is not None and not vehicle.edge.startswith(":"):
                if driven[-1] != vehicle.edge:
                    driven.append(vehicle.edge)
            return state.ambulance.status == "arrived"

        run(engine, 180, until=arrived)
        assert tuple(driven) == dispatch_plan.edges
    finally:
        engine.close()

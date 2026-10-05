"""Sprint 8: accidents against real SUMO (grid2x2, seed 42).

A wreck held in one lane, the suggested route re-planned round it ("route compromised"),
the autopilot taking the new route, and the wrecks gone on clear and on reset.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from api.protocol import state_message
from simulation.engine import (
    ClearIncidents,
    Control,
    EngineState,
    InjectAccident,
    Reset,
    Routing,
    SimulationEngine,
)
from simulation.incidents import WRECK_PREFIX, is_wreck
from simulation.sumo import SumoConfig
from tests.helpers import command, run, spawn

HOSPITAL = "B1_e1"


def make_engine(
    tmp_path: Path, control: Control = "manual", routing: Routing = "dynamic"
) -> SimulationEngine:
    engine = SimulationEngine(
        SumoConfig(log_path=tmp_path / "sumo.log"),
        realtime=False,
        deadman_s=None,
        mode="BASIC",
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


def wreck_of(state: EngineState, incident_id: str) -> tuple[str, int, float, float, float]:
    vehicle = state.snapshot.vehicle(incident_id)
    assert vehicle is not None, "the wreck left the road"
    return vehicle.edge, vehicle.lane, vehicle.x, vehicle.y, vehicle.speed


def test_an_accident_on_the_route_compromises_it_and_the_route_goes_round(
    manual: SimulationEngine,
) -> None:
    before = spawn(manual)
    assert before.route is not None
    old_route = before.route.edges
    result = command(manual, InjectAccident())  # default: the road after the next junction
    assert result.ok and "route compromised" in result.reason, result.reason
    state = run(manual, 0.2)
    (incident,) = state.incidents
    assert incident.edge == old_route[1] and incident.lane == 0
    route = state.route
    assert route is not None
    assert route.compromised_by == incident.edge
    assert incident.edge not in route.edges  # a way round exists on the grid
    assert not route.blocked_ahead
    assert route.eta_change_s is not None and abs(route.eta_change_s) < 30

    msg = state_message(state).model_dump(by_alias=True)
    assert not any(is_wreck(v["id"]) for v in msg["vehicles"])  # drawn as an incident
    assert msg["incidents"][0]["edge"] == incident.edge
    assert msg["route"]["compromised"] is True and msg["route"]["compromisedBy"] == incident.edge

    # The wreck stays where it crashed: stopped, in its lane, at the reported spot.
    placed = wreck_of(state, incident.id)
    later = run(manual, 60)
    edge, lane, x, y, speed = wreck_of(later, incident.id)
    assert (edge, lane, speed) == (incident.edge, 0, 0.0)
    assert (x, y) == pytest.approx(placed[2:4], abs=0.01)
    assert (x, y) == pytest.approx((incident.x, incident.y), abs=1.0)
    assert later.safety.violations == 0 and later.safety.collisions == 0


def test_bad_accident_requests_are_rejected(manual: SimulationEngine) -> None:
    no_route = command(manual, InjectAccident())
    assert not no_route.ok and "dispatch first" in no_route.reason
    unknown = command(manual, InjectAccident("Z9_Z8"))
    assert not unknown.ok and "no road" in unknown.reason
    hospital = command(manual, InjectAccident(HOSPITAL))
    assert not hospital.ok and "hospital" in hospital.reason
    assert command(manual, InjectAccident("A0_B0")).ok  # any road, no ambulance needed
    twice = command(manual, InjectAccident("A0_B0"))
    assert not twice.ok and "already" in twice.reason
    assert len(run(manual, 0.1).incidents) == 1


def test_clear_and_reset_remove_the_wrecks(manual: SimulationEngine) -> None:
    assert command(manual, InjectAccident("A0_B0")).ok
    assert command(manual, InjectAccident("A1_B1")).ok
    state = run(manual, 1)
    assert len(state.incidents) == 2
    wrecks = [v.id for v in state.snapshot.vehicles if is_wreck(v.id)]
    assert len(wrecks) == 2
    cleared = command(manual, ClearIncidents())
    assert cleared.ok and cleared.reason == "cleared 2 accident(s)"
    state = run(manual, 0.2)
    assert state.incidents == ()
    assert not any(v.id.startswith(WRECK_PREFIX) for v in state.snapshot.vehicles)

    assert command(manual, InjectAccident("A0_B0")).ok
    assert command(manual, Reset()).ok
    state = run(manual, 0.2)
    assert state.incidents == ()
    assert not any(is_wreck(v.id) for v in state.snapshot.vehicles)


def test_autopilot_takes_the_way_round_and_arrives(tmp_path: Path) -> None:
    engine = make_engine(tmp_path, control="autopilot")
    try:
        before = spawn(engine)
        assert before.route is not None
        blocked = before.route.edges[1]
        assert command(engine, InjectAccident(blocked)).ok
        travelled: list[str] = []

        def arrived(state: EngineState) -> bool:
            vehicle = state.snapshot.vehicle("ambulance_01")
            if vehicle is not None and (not travelled or travelled[-1] != vehicle.edge):
                travelled.append(vehicle.edge)
            return state.ambulance.status == "arrived"

        final = run(engine, 180, until=arrived)
        assert blocked not in travelled
        assert travelled[-1] == HOSPITAL
        assert final.safety.violations == 0 and final.safety.collisions == 0
        reroutes = [e for e in final.safety.events if e.action == "reroute"]
        assert all(e.accepted for e in reroutes)
    finally:
        engine.close()


def test_static_routing_keeps_its_map_route_through_the_accident(tmp_path: Path) -> None:
    engine = make_engine(tmp_path, routing="static")
    try:
        before = spawn(engine)
        assert before.route is not None
        blocked = before.route.edges[1]
        assert command(engine, InjectAccident(blocked)).ok
        state = run(engine, 2)
        assert state.route is not None
        assert blocked in state.route.edges  # static: what a map without live data says
        assert state.route.blocked_ahead and state.route.compromised_by == blocked
    finally:
        engine.close()

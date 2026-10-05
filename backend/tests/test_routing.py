"""Sprint 6: live-cost routing (pure) and the safety review of autopilot reroutes."""

from __future__ import annotations

import dataclasses
import math

import pytest

from ai.routing import (
    AMBULANCE_TOP_SPEED,
    HEADWAY_S,
    INCIDENT_PENALTY_S,
    Conditions,
    EdgeTraffic,
    Movement,
    RoadEdge,
    RoadGraph,
    SignalClock,
    clearly_faster,
    evaluate_route,
    expected_red_wait,
    plan_route,
    turn_kind,
)
from safety.controller import SafetyController
from simulation.network import RoadNetwork
from simulation.sumo import SumoConfig
from simulation.traffic_lights import load_signal_tables

# The grid's fixed-time program: link 0 green in phases 0-1 (31 s + 4 s yellow), red after.
PROGRAM = (("Gr", 31.0), ("yr", 4.0), ("rr", 2.0), ("rG", 31.0), ("ry", 4.0), ("rr", 2.0))


def diamond(direct_length: float = 400.0) -> RoadGraph:
    """S -> A or B -> D: two ways round, through signal X (link 0) or Y (link 0).
    Side A is 50 m shorter, so it wins in free flow."""

    def edge(eid: str, to: str, moves: tuple[Movement, ...], length: float = 200.0) -> RoadEdge:
        return RoadEdge(eid, length, 13.89, 2, to, moves)

    s_moves = (Movement("A", "left", "X", 0, 8.0), Movement("B", "right", "Y", 0, 17.0))
    return RoadGraph(
        {
            "S": edge("S", "J", s_moves),
            "A": edge("A", "K", (Movement("D", "right", None, None, 17.0),), length=150.0),
            "B": edge("B", "K", (Movement("D", "left", None, None, 8.0),)),
            "D": edge("D", "H", (), length=direct_length),
        }
    )


def test_turn_kinds_follow_sumo_directions() -> None:
    assert [turn_kind(d) for d in "slLrRtT"] == [
        "straight", "left", "left", "right", "right", "uturn", "uturn",
    ]  # fmt: skip


def test_signal_clock_predicts_the_fixed_time_program() -> None:
    clock = SignalClock(phase=0, next_switch=31.0, phases=PROGRAM)
    assert clock.state_at(0.0, 10.0) == "Gr"
    assert clock.state_at(0.0, 32.0) == "yr"
    assert clock.state_at(0.0, 40.0) == "rG"
    assert clock.state_at(0.0, 74.0 * 10 + 5.0) == "Gr"  # whole cycles fold away
    assert clock.wait_for_green(0.0, 10.0, 0) == 0.0
    assert clock.wait_for_green(0.0, 32.0, 0) == pytest.approx(74.0 - 32.0)  # yellow: wait
    assert clock.wait_for_green(0.0, 40.0, 1) == 0.0
    assert clock.wait_for_green(0.0, 20.0, 1) == pytest.approx(17.0)
    late = SignalClock(phase=3, next_switch=50.0, phases=PROGRAM)  # mid cross green
    assert late.wait_for_green(45.0, 45.0, 0) == pytest.approx(5.0 + 4.0 + 2.0)


def test_expected_red_wait_for_random_arrivals() -> None:
    # link 0 is red/yellow for 43 s of every 74 s: mean wait 43^2 / 2 / 74
    assert expected_red_wait(PROGRAM, 0) == pytest.approx(43.0**2 / 2 / 74.0)
    assert expected_red_wait((("G", 10.0),), 0) == 0.0


def test_free_flow_eta_is_distance_over_top_speed() -> None:
    plan = plan_route(diamond(), "S", 0.0, "D", 100.0, Conditions(now=0.0, mode="BASIC"))
    assert plan is not None
    assert plan.edges == ("S", "A", "D")
    assert plan.distance_m == pytest.approx(200 + 150 + 100)
    assert plan.drive_s == pytest.approx(plan.eta_s)
    assert plan.eta_s >= 450 / AMBULANCE_TOP_SPEED


def test_live_traffic_moves_the_route_to_the_other_side() -> None:
    graph = diamond()
    free = plan_route(graph, "S", 0.0, "D", 100.0, Conditions(now=0.0, mode="BASIC"))
    assert free is not None and free.edges[1] == "A"  # the shorter side
    jam = {"A": EdgeTraffic(mean_speed=1.0, halting=12, vehicles=20)}
    plan = plan_route(graph, "S", 0.0, "D", 100.0, Conditions(now=0.0, mode="BASIC", traffic=jam))
    assert plan is not None and plan.edges[1] == "B"


def test_one_car_creeping_into_a_queue_does_not_slow_the_ambulance() -> None:
    """Regression (Sprint 7): a single slow mover on a two-lane road once priced the road at
    70 s and made a U-turn detour look faster; the queue itself is charged separately."""
    graph = diamond()
    creeping = {"A": EdgeTraffic(mean_speed=0.4, halting=4, vehicles=5)}  # 1 moving at ~2 m/s
    plan = plan_route(graph, "S", 0.0, "D", 100.0, Conditions(0.0, "BASIC", creeping))
    assert plan is not None and plan.edges[1] == "A"
    crawling = {"A": EdgeTraffic(mean_speed=1.0, halting=2, vehicles=12)}  # 10 moving at ~1.2 m/s
    jammed = plan_route(graph, "S", 0.0, "D", 100.0, Conditions(0.0, "BASIC", crawling))
    assert jammed is not None and jammed.edges[1] == "B"


def test_off_mode_avoids_a_long_red_but_preemption_ignores_it() -> None:
    graph = diamond()
    x_red = SignalClock(phase=3, next_switch=30.0, phases=PROGRAM)  # X link 0 red for a while
    y_green = SignalClock(phase=0, next_switch=60.0, phases=PROGRAM)
    signals = {"X": x_red, "Y": y_green}
    off = plan_route(graph, "S", 0.0, "D", 100.0, Conditions(0.0, "OFF", signals=signals))
    assert off is not None and off.edges[1] == "B" and off.signal_s == 0.0
    basic = plan_route(graph, "S", 0.0, "D", 100.0, Conditions(0.0, "BASIC", signals=signals))
    assert basic is not None and basic.edges[1] == "A"  # preempted: no red wait


def test_queues_cost_two_seconds_per_vehicle_and_lane_in_off_mode() -> None:
    graph = diamond()
    queue = {"S": EdgeTraffic(mean_speed=13.89, halting=10, vehicles=10)}
    green = {"X": SignalClock(0, 60.0, PROGRAM), "Y": SignalClock(0, 60.0, PROGRAM)}
    off = plan_route(graph, "S", 0.0, "D", 100.0, Conditions(0.0, "OFF", queue, green))
    assert off is not None and off.queue_s == pytest.approx(10 / 2 * HEADWAY_S)
    basic = plan_route(graph, "S", 0.0, "D", 100.0, Conditions(0.0, "BASIC", queue, green))
    assert basic is not None and basic.queue_s == 1.0  # 10 s of queue, 9 s of head start
    # COORD prices queues like BASIC: route choice must not depend on the signal mode
    coord = plan_route(graph, "S", 0.0, "D", 100.0, Conditions(0.0, "COORD", queue, green))
    assert coord is not None and coord.queue_s == basic.queue_s and coord.edges == basic.edges


def test_closed_roads_are_avoided_and_no_way_means_no_route() -> None:
    graph = diamond()
    closed = Conditions(0.0, "BASIC", incidents={"A": math.inf})
    plan = plan_route(graph, "S", 0.0, "D", 100.0, closed)
    assert plan is not None and "A" not in plan.edges
    both = Conditions(0.0, "BASIC", incidents={"A": math.inf, "B": math.inf})
    assert plan_route(graph, "S", 0.0, "D", 100.0, both) is None


def test_an_accident_steers_the_route_but_is_not_counted_as_predicted_time() -> None:
    graph = diamond()
    free = plan_route(graph, "S", 0.0, "D", 100.0, Conditions(0.0, "BASIC"))
    assert free is not None and free.edges[1] == "A" and free.incident_s == 0.0
    accident = Conditions(0.0, "BASIC", incidents={"A": INCIDENT_PENALTY_S})
    plan = plan_route(graph, "S", 0.0, "D", 100.0, accident)
    assert plan is not None and "A" not in plan.edges and plan.incident_s == 0.0
    # No way round: the route passes the accident; the penalty is in the cost (eta_s) but
    # the prediction leaves it out (live traffic around the wreck is the prediction).
    both = Conditions(0.0, "BASIC", incidents={"A": INCIDENT_PENALTY_S, "B": INCIDENT_PENALTY_S})
    through = plan_route(graph, "S", 0.0, "D", 100.0, both)
    assert through is not None and through.incident_s == INCIDENT_PENALTY_S
    assert through.predicted_eta_s == pytest.approx(through.eta_s - INCIDENT_PENALTY_S)
    assert through.predicted_eta_s == pytest.approx(free.eta_s, abs=0.01)


def test_a_given_route_is_priced_like_the_search_prices_it() -> None:
    graph = diamond()
    conditions = Conditions(0.0, "BASIC", {"B": EdgeTraffic(5.0, 3, 6)})
    best = plan_route(graph, "S", 10.0, "D", 100.0, conditions, start_speed=0.0)
    assert best is not None
    same = evaluate_route(graph, best.edges, 10.0, 100.0, conditions, start_speed=0.0)
    assert same == best
    other = evaluate_route(graph, ("S", "B", "D"), 10.0, 100.0, conditions, start_speed=0.0)
    assert other is not None and other.eta_s > best.eta_s
    assert evaluate_route(graph, ("S", "D"), 0.0, 100.0, conditions) is None  # no such turn


def test_a_standing_start_costs_the_acceleration() -> None:
    graph = diamond()
    moving = plan_route(graph, "S", 0.0, "D", 100.0, Conditions(0.0, "BASIC"))
    standing = plan_route(graph, "S", 0.0, "D", 100.0, Conditions(0.0, "BASIC"), start_speed=0.0)
    assert moving is not None and standing is not None
    assert standing.eta_s - moving.eta_s == pytest.approx(22.0 / (2 * 3.5), abs=0.01)


def test_the_suggestion_only_switches_for_a_clear_gain() -> None:
    plan = plan_route(diamond(), "S", 0.0, "D", 100.0, Conditions(0.0, "BASIC"))
    assert plan is not None
    slightly = dataclasses.replace(plan, eta_s=plan.eta_s - 4.0)  # under 5 s and 10 %
    clearly = dataclasses.replace(plan, eta_s=plan.eta_s - 8.0)
    assert not clearly_faster(slightly, plan)
    assert clearly_faster(clearly, plan)


def test_starting_on_the_destination_road() -> None:
    plan = plan_route(diamond(), "D", 20.0, "D", 100.0, Conditions(now=5.0, mode="OFF"))
    assert plan is not None and plan.edges == ("D",) and plan.turns == ()
    assert plan.distance_m == pytest.approx(80.0)
    assert plan.computed_at == 5.0


def test_grid_graph_has_no_u_turns_at_signals() -> None:
    graph = RoadNetwork("grid2x2").road_graph()
    assert len(graph.edges) == 24
    for edge in graph.edges.values():
        for move in edge.movements:
            if move.tls is not None:
                assert move.turn != "uturn" and move.link_index is not None
    assert [m.turn for m in graph.edges["B1_e1"].movements] == ["uturn"]  # map edge
    left = graph.movement("w0_A0", "A0_A1")
    assert left is not None and left.turn == "left"  # left-hand traffic: short turn
    right = graph.movement("w0_A0", "A0_sA")
    assert right is not None and right.turn == "right" and right.length > left.length


# ---- safety review of autopilot reroutes ------------------------------------------------
@pytest.fixture(scope="module")
def controller_and_graph() -> tuple[SafetyController, dict[str, frozenset[str]]]:
    tables = load_signal_tables(SumoConfig().net_path)
    successors = RoadNetwork("grid2x2").road_graph().successors()
    return SafetyController(tables), successors


def test_a_valid_route_is_accepted_and_logged_once(
    controller_and_graph: tuple[SafetyController, dict[str, frozenset[str]]],
) -> None:
    controller, successors = controller_and_graph
    route = ("w0_A0", "A0_A1", "A1_B1", "B1_e1")
    for _ in range(3):
        decision = controller.review_reroute(
            1.0, "ambulance_01", "emergency", "A0", "w0_A0", route, successors, "B1_e1"
        )
        assert decision.accepted
    reroutes = [e for e in controller.events if e.action == "reroute"]
    assert len(reroutes) == 1 and reroutes[0].accepted and "A0_A1" in reroutes[0].reason


@pytest.mark.parametrize(
    ("vehicle_class", "current", "route", "closed", "code"),
    [
        ("passenger", "w0_A0", ("w0_A0", "A0_A1", "A1_B1", "B1_e1"), (), "unauthorized"),
        ("emergency", "A0_B0", ("w0_A0", "A0_A1", "A1_B1", "B1_e1"), (), "stale"),
        ("emergency", "w0_A0", ("w0_A0", "A0_B0", "B0_B1", "B1_A1"), (), "destination"),
        ("emergency", "w0_A0", ("w0_A0", "A0_B0", "B0_B1", "B1_A1", "B1_e1"), (), "disconnected"),
        ("emergency", "w0_A0", ("w0_A0", "A0_A1", "A1_B1", "B1_e1"), ("A1_B1",), "closed"),
    ],
)
def test_bad_routes_are_rejected(
    controller_and_graph: tuple[SafetyController, dict[str, frozenset[str]]],
    vehicle_class: str,
    current: str,
    route: tuple[str, ...],
    closed: tuple[str, ...],
    code: str,
) -> None:
    controller, successors = controller_and_graph
    decision = controller.review_reroute(
        2.0, "ambulance_01", vehicle_class, "A0", current, route, successors, "B1_e1",
        closed=frozenset(closed),
    )  # fmt: skip
    assert not decision.accepted and decision.code == code
    assert controller.events[-1].action == "reroute" and not controller.events[-1].accepted

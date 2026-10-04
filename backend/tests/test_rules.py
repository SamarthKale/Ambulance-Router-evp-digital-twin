"""Sprint 3: BASIC preemption rule (pure)."""

from __future__ import annotations

from ai.rules import PREEMPT_LEAD_S, AmbulanceView, Preempt, Release, basic_preemption, eta_s


def view(
    next_junction: str | None = "A0",
    distance: float | None = 200.0,
    speed: float = 20.0,
    edge: str = "w0_A0",
) -> AmbulanceView:
    return AmbulanceView(
        vehicle_id="ambulance_01",
        vehicle_class="emergency",
        edge=edge,
        speed=speed,
        next_junction=next_junction,
        next_link=13 if next_junction else None,
        next_distance=distance,
    )


def test_preempts_within_the_lead_time() -> None:
    assert basic_preemption(view(distance=290, speed=20), []) == [Preempt("A0", 13, 14.5)]
    assert basic_preemption(view(distance=310, speed=20), []) == []  # ETA 15.5 s
    assert eta_s(300, 20) == PREEMPT_LEAD_S


def test_a_stopped_ambulance_at_the_stop_line_still_gets_green() -> None:
    actions = basic_preemption(view(distance=8, speed=0), [])
    assert actions == [Preempt("A0", 13, 1.6)]  # ETA uses a 5 m/s floor


def test_does_not_ask_again_while_held() -> None:
    assert basic_preemption(view(distance=100), ["A0"]) == []


def test_keeps_the_junction_while_crossing_or_still_approaching_slowly() -> None:
    # B0 is 400 m away (ETA 20 s), so only A0's fate matters here
    assert basic_preemption(view(next_junction="B0", distance=400, edge=":A0_13_0"), ["A0"]) == []
    assert basic_preemption(view(distance=150, speed=1), ["A0"]) == []  # ETA 30 s: kept


def test_releases_once_the_ambulance_has_passed() -> None:
    actions = basic_preemption(view(next_junction="B0", distance=400, edge="A0_B0"), ["A0"])
    assert actions == [Release("A0", "ambulance cleared A0")]


def test_releases_everything_when_the_ambulance_is_gone() -> None:
    assert basic_preemption(None, ["A0", "B0"]) == [
        Release("A0", "ambulance left the road"),
        Release("B0", "ambulance left the road"),
    ]


def test_passing_one_junction_and_approaching_the_next() -> None:
    actions = basic_preemption(view(next_junction="B0", distance=200, edge="A0_B0"), ["A0"])
    assert actions == [Release("A0", "ambulance cleared A0"), Preempt("B0", 13, 10.0)]

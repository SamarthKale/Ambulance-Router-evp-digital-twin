"""BASIC preemption rule (CLAUDE.md section 7). Pure logic, no TraCI.

The rule only proposes; the safety controller decides and actuates.
  - Preempt the ambulance's next signal once its ETA is within the lead time.
  - Release a junction once the ambulance has passed it (it is no longer the next signal
    and the ambulance is not inside it) or the ambulance is gone. A junction is not
    released just because the ambulance slowed down; the controller's 40 s limit
    protects cross traffic.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

PREEMPT_LEAD_S = 15.0
ETA_SPEED_FLOOR = 5.0  # m/s: a slow or stopped ambulance near the stop line still gets green


@dataclass(frozen=True)
class AmbulanceView:
    vehicle_id: str
    vehicle_class: str
    edge: str  # ":<junction>_<n>" while inside a junction
    speed: float  # m/s
    next_junction: str | None
    next_link: int | None
    next_distance: float | None  # m to the stop line
    behind: str | None = None  # the junction the ambulance's current road starts at


@dataclass(frozen=True)
class Preempt:
    junction: str
    link_index: int
    eta_s: float
    note: str = ""  # why now (COORD: queue and lead time), for the safety log


@dataclass(frozen=True)
class Release:
    junction: str
    reason: str


RuleAction = Preempt | Release


def eta_s(distance: float, speed: float) -> float:
    return distance / max(speed, ETA_SPEED_FLOOR)


def basic_preemption(ambulance: AmbulanceView | None, held: Iterable[str]) -> list[RuleAction]:
    """`held`: junctions currently clearing or preempted for this ambulance."""
    actions: list[RuleAction] = []
    held = list(held)
    for junction in held:
        if ambulance is None:
            actions.append(Release(junction, "ambulance left the road"))
        elif ambulance.edge.startswith(f":{junction}_"):
            continue  # still crossing
        elif ambulance.next_junction != junction:
            actions.append(Release(junction, f"ambulance cleared {junction}"))
    if (
        ambulance is not None
        and ambulance.next_junction is not None
        and ambulance.next_link is not None
        and ambulance.next_distance is not None
        and ambulance.next_junction not in held
    ):
        eta = eta_s(ambulance.next_distance, ambulance.speed)
        if eta <= PREEMPT_LEAD_S:
            actions.append(Preempt(ambulance.next_junction, ambulance.next_link, eta))
    return actions

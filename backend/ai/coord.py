"""COORD preemption rule (CLAUDE.md section 7). Rule-based, not learned; pure logic, no TraCI.

Like BASIC it only proposes; the safety controller decides and actuates. It differs in two
ways:
  - Queue-aware lead time: a junction is preempted when the ambulance's ETA is within
    clearance (yellow + all-red) + start-up loss + the time the queue in front of it needs
    to discharge (+ a margin for ETA error). An empty approach is held for less time than
    BASIC's fixed 15 s; a long queue is cleared before the ambulance gets there.
  - Downstream preparation: the same rule for the next junctions on the ambulance's route
    (up to PREPARE_AHEAD of them), so their queues are gone too.
Release: at once for the junction the ambulance has just crossed; after RELEASE_GRACE_S for
one that dropped off the route ahead (the driver turned elsewhere, or the plan flickered for
a tick). The safety controller's 40 s limit still protects cross traffic.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from ai.rules import ETA_SPEED_FLOOR, AmbulanceView, Preempt, Release, RuleAction
from safety.controller import MAX_PREEMPT_S
from safety.invariants import ALL_RED_MIN_S, YELLOW_MIN_S

CLEARANCE_S = YELLOW_MIN_S + ALL_RED_MIN_S
STARTUP_LOSS_S = 2.0  # the first queued vehicle needs this long to get going
HEADWAY_S = 2.0  # per queued vehicle and lane
MARGIN_S = 3.0  # ETA error allowance: the ambulance must not reach a yellow or all-red
MAX_LEAD_S = MAX_PREEMPT_S - 10.0  # leave room within the 40 s limit for ETA error
PREPARE_AHEAD = 3  # the next junction and up to two after it
RELEASE_GRACE_S = 2.0  # off the route this long before a prepared junction is given back


@dataclass(frozen=True)
class Upcoming:
    """A signalised junction ahead on the ambulance's route."""

    junction: str
    link_index: int  # the ambulance's link there
    approach: str  # the road it arrives on
    distance: float  # m from the ambulance to that stop line
    queue: int  # vehicles halted on the approach, ahead of the ambulance
    lanes: int


def lead_time_s(queue: int, lanes: int) -> float:
    """How long before the ambulance arrives the junction must start clearing."""
    discharge = queue / max(1, lanes) * HEADWAY_S
    return min(MAX_LEAD_S, CLEARANCE_S + STARTUP_LOSS_S + discharge + MARGIN_S)


class CoordPreemption:
    """The COORD rule. Keeps one piece of memory: since when a held junction has been off
    the route ahead."""

    def __init__(self) -> None:
        self._off_route_since: dict[str, float] = {}

    def __call__(
        self,
        ambulance: AmbulanceView | None,
        upcoming: Sequence[Upcoming],
        held: Iterable[str],
        now: float,
    ) -> list[RuleAction]:
        """`upcoming`: signalised junctions ahead, nearest first. `held`: junctions
        currently clearing or preempted for this ambulance."""
        actions: list[RuleAction] = []
        held = list(held)
        ahead = [u.junction for u in upcoming[:PREPARE_AHEAD]]
        for junction in held:
            if ambulance is None:
                actions.append(Release(junction, "ambulance left the road"))
            elif ambulance.edge.startswith(f":{junction}_") or junction in ahead:
                self._off_route_since.pop(junction, None)  # crossing it, or still ahead
            elif junction == ambulance.behind:
                actions.append(Release(junction, f"ambulance cleared {junction}"))
            else:
                since = self._off_route_since.setdefault(junction, now)
                if now - since >= RELEASE_GRACE_S - 1e-6:
                    actions.append(Release(junction, f"{junction} is no longer on the route"))
        for junction in list(self._off_route_since):
            if junction not in held:
                del self._off_route_since[junction]
        if ambulance is None:
            return actions
        speed = max(ambulance.speed, ETA_SPEED_FLOOR)
        for u in upcoming[:PREPARE_AHEAD]:
            if u.junction in held:
                continue
            eta = u.distance / speed
            lead = lead_time_s(u.queue, u.lanes)
            if eta <= lead:
                note = f"queue {u.queue}, lead {lead:.0f} s"
                if u.junction != ambulance.next_junction:
                    note += ", prepared ahead"
                actions.append(Preempt(u.junction, u.link_index, eta, note))
        return actions

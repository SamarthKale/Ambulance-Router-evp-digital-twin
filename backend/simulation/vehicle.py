"""The ambulance: identity, spawning at the depot, and the status reported each tick."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from traci.connection import Connection

from simulation.network import RoadNetwork

AMBULANCE_ID = "ambulance_01"
AMBULANCE_TYPE = "ambulance"  # vType in routes.rou.xml (vClass emergency)

Direction = Literal["left", "right"]
TurnKind = Literal["left", "straight", "right", "uturn"]
MissionStatus = Literal["none", "pending", "driving", "arrived"]


@dataclass(frozen=True)
class NextSignal:
    junction: str
    link_index: int  # the signal link the ambulance will use
    distance: float  # m to the stop line
    state: str  # SUMO signal char of the ambulance's own link (G g y r ...)


@dataclass(frozen=True)
class PlannedTurn:
    junction: str
    turn: TurnKind
    edge: str  # road taken after the junction


@dataclass(frozen=True)
class AmbulanceStatus:
    status: MissionStatus
    throttle: float = 0.0  # input actually applied (after the deadman timer)
    brake: float = 0.0
    next_signal: NextSignal | None = None
    planned_turn: PlannedTurn | None = None
    queued_turn: Direction | None = None  # pressed inside a junction, applies at the next one
    mission_time: float | None = None  # s since spawn, frozen on arrival


def spawn_ambulance(
    conn: Connection, network: RoadNetwork, route_id: str, type_id: str = AMBULANCE_TYPE
) -> None:
    """(Re)insert the ambulance at the depot, curb lane, standing still. `type_id`: a variant
    of the ambulance vType (batch experiments only, e.g. one allowed to cross red lights)."""
    if AMBULANCE_ID in conn.vehicle.getIDList():
        conn.vehicle.remove(AMBULANCE_ID)
    conn.route.add(route_id, [network.depot.edge])
    conn.vehicle.add(
        AMBULANCE_ID,
        route_id,
        typeID=type_id,
        depart="now",
        departLane="0",
        departPos=str(network.depot.pos),
        departSpeed="0",
    )

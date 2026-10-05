"""Accidents (CLAUDE.md sections 1 and 13: accidents only, no road closures).

An accident is a wrecked car standing in one lane of a road, mid-way along it: SUMO keeps
it there with a stop, and traffic behind merges into the other lane, so the road stays
passable but slow. The routing layer adds a penalty for the road (ai/routing.py).

Simulation layer: these are the only TraCI calls for incidents. The wrecks are vehicles in
SUMO (so traffic reacts to them), filtered out of the vehicle list sent to the frontend,
which draws them from the incident list instead.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from itertools import count

from traci.connection import Connection
from traci.exceptions import TraCIException

from simulation.network import RoadNetwork

WRECK_PREFIX = "incident_"
WRECK_TYPE = "wrecked_car"  # vType id = 3D asset key
WRECK_BASE_TYPE = "car_sedan"
ACCIDENT_AT = 0.55  # fraction along the road
MIN_ROAD_M = 60.0  # too short a road leaves no room before the junction
STOP_S = 1e6  # stays until cleared


@dataclass(frozen=True)
class Incident:
    id: str
    type: str  # "accident"
    edge: str
    lane: int  # 0 = curb lane
    pos: float  # m along the road
    x: float  # SUMO coordinates of the wreck
    y: float
    angle: float  # deg clockwise from north, along the road
    since: float  # simulation time


class IncidentError(ValueError):
    """The incident can't be placed (unknown road, too short, already blocked...)."""


class Incidents:
    def __init__(self, conn: Connection, network: RoadNetwork) -> None:
        self._conn = conn
        self._network = network
        self._ids = count(1)
        self._active: dict[str, Incident] = {}
        self._wreck_length: float | None = None

    @property
    def active(self) -> tuple[Incident, ...]:
        return tuple(self._active.values())

    def blocked_edges(self) -> frozenset[str]:
        return frozenset(i.edge for i in self._active.values())

    def add_accident(self, edge_id: str, now: float, lane: int = 0) -> Incident:
        net = self._network.net
        if not net.hasEdge(edge_id) or edge_id.startswith(":"):
            raise IncidentError(f"no road {edge_id}")
        edge = net.getEdge(edge_id)
        if edge_id in self.blocked_edges():
            raise IncidentError(f"{edge_id} already has an accident")
        if edge.getLength() < MIN_ROAD_M:
            raise IncidentError(f"{edge_id} is too short for an accident")
        if edge_id == self._network.hospital.edge:
            raise IncidentError("not on the hospital road")
        lane = max(0, min(lane, edge.getLaneNumber() - 1))
        length = self._ensure_type()
        pos = round(edge.getLength() * ACCIDENT_AT, 1)  # the wreck's centre
        front = pos + length / 2  # SUMO places and stops vehicles by their front bumper
        incident_id = f"{WRECK_PREFIX}{next(self._ids)}"
        route_id = f"{incident_id}_route"
        try:
            self._conn.route.add(route_id, [edge_id])
            self._conn.vehicle.add(
                incident_id,
                route_id,
                typeID=WRECK_TYPE,
                depart="now",
                departLane=str(lane),
                departPos=f"{front:.2f}",
                departSpeed="0",
            )
            # stopped where it stands, until cleared
            self._conn.vehicle.setStop(
                incident_id, edge_id, pos=front, laneIndex=lane, duration=STOP_S
            )
            # a wreck doesn't change lanes or move off: no lane changes, no speed
            self._conn.vehicle.setLaneChangeMode(incident_id, 0)
        except TraCIException as exc:
            raise IncidentError(f"SUMO refused the accident on {edge_id}: {exc}") from exc
        shape = edge.getLane(lane).getShape()
        x, y = _point_along(shape, pos)
        incident = Incident(
            id=incident_id,
            type="accident",
            edge=edge_id,
            lane=lane,
            pos=pos,
            x=round(x, 2),
            y=round(y, 2),
            angle=round(_angle_along(shape, pos), 1),
            since=round(now, 1),
        )
        self._active[incident_id] = incident
        return incident

    def clear(self) -> int:
        cleared = 0
        present = set(self._conn.vehicle.getIDList())
        for incident_id in list(self._active):
            if incident_id in present:
                try:
                    self._conn.vehicle.remove(incident_id)
                except TraCIException:
                    pass  # already gone
            del self._active[incident_id]
            cleared += 1
        return cleared

    def _ensure_type(self) -> float:
        """Create the wreck vType once per simulation; returns its length in m."""
        if self._wreck_length is None:
            if WRECK_TYPE not in self._conn.vehicletype.getIDList():
                self._conn.vehicletype.copy(WRECK_BASE_TYPE, WRECK_TYPE)
                self._conn.vehicletype.setColor(WRECK_TYPE, (60, 60, 60, 255))
            self._wreck_length = float(self._conn.vehicletype.getLength(WRECK_TYPE))
        return self._wreck_length


def is_wreck(vehicle_id: str) -> bool:
    return vehicle_id.startswith(WRECK_PREFIX)


def _point_along(shape: list[tuple[float, float]], pos: float) -> tuple[float, float]:
    remaining = pos
    for (x1, y1), (x2, y2) in zip(shape, shape[1:], strict=False):
        seg = math.hypot(x2 - x1, y2 - y1)
        if remaining <= seg or seg == 0:
            t = remaining / seg if seg else 0.0
            return x1 + (x2 - x1) * t, y1 + (y2 - y1) * t
        remaining -= seg
    return shape[-1][0], shape[-1][1]


def _angle_along(shape: list[tuple[float, float]], pos: float) -> float:
    remaining = pos
    for (x1, y1), (x2, y2) in zip(shape, shape[1:], strict=False):
        seg = math.hypot(x2 - x1, y2 - y1)
        if remaining <= seg:
            return math.degrees(math.atan2(x2 - x1, y2 - y1)) % 360  # clockwise from north
        remaining -= seg
    (x1, y1), (x2, y2) = shape[-2], shape[-1]
    return math.degrees(math.atan2(x2 - x1, y2 - y1)) % 360

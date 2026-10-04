"""Manual ambulance control: keyboard intent -> SUMO (CLAUDE.md section 2.6).

SUMO stays authoritative: we nudge the target speed, choose the next road at each
junction and request lane changes. Signals are never touched here.

Threading: every method may call TraCI, so it must only run on the simulation thread.
The engine applies queued WebSocket commands there (CLAUDE.md section 2.7).

Rewritten in Sprint 2 from the reference demo. Changes: commands only record intent;
TraCI connection injected (no global traci module); Q/E follow the driving side (lane 0
is the curb lane, on the left in left-hand traffic); turns pressed inside a junction
are queued for the next one; infeasible turns are rejected with a reason; U-turn when
it is the only way on (map edge); the ambulance parks at the hospital; the deadman
clock is injectable.
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable
from dataclasses import dataclass

import sumolib
from traci import constants as tc
from traci.connection import Connection
from traci.exceptions import TraCIException

from simulation.network import RoadNetwork
from simulation.sumo import VehicleState
from simulation.vehicle import (
    AMBULANCE_ID,
    AmbulanceStatus,
    Direction,
    MissionStatus,
    NextSignal,
    PlannedTurn,
    TurnKind,
)

ACCEL = 3.5  # m/s^2 at full throttle (= ambulance vType accel)
BRAKE = 6.0  # m/s^2 at full brake (= ambulance vType decel)
COAST = 1.0  # m/s^2 natural slowdown with no input
VMAX = 22.0  # m/s cap (~80 km/h)
TURN_MIN_DEG = 20.0  # heading change that counts as a left/right turn
DEADMAN_S = 0.5  # zero the input if no drive message arrives within this time
SPEED_MODE = 31  # every check on: safe speed, accel/decel limits, right of way, red lights
LANE_CHANGE_MODE = 0b10_0000_0001  # 513: only route-required changes; Q/E respect others' gaps
LANE_CHANGE_HOLD_S = 3.0  # how long a Q/E lane request is held
LANE_CHANGE_ROOM_M = 25.0  # road needed per lane change before the stop line...
LANE_CHANGE_TIME_S = 2.0  # ...or this long at the current speed, whichever is more

Edge = sumolib.net.edge.Edge
_LANE_BLOCKED = (
    tc.LCA_BLOCKED_BY_LEFT_LEADER
    | tc.LCA_BLOCKED_BY_LEFT_FOLLOWER
    | tc.LCA_BLOCKED_BY_RIGHT_LEADER
    | tc.LCA_BLOCKED_BY_RIGHT_FOLLOWER
    | tc.LCA_OVERLAPPING
    | tc.LCA_INSUFFICIENT_SPACE
)


@dataclass(frozen=True)
class CommandResult:
    ok: bool
    reason: str = ""


OK = CommandResult(True)


class ManualController:
    def __init__(
        self,
        conn: Connection,
        network: RoadNetwork,
        clock: Callable[[], float] = time.monotonic,
        deadman_s: float | None = DEADMAN_S,  # None disables it (batch autopilot runs)
    ) -> None:
        self._conn = conn
        self._network = network
        self._net = network.net
        self._clock = clock
        self._deadman_s = deadman_s
        self._reset("none", 0.0)

    def _reset(self, status: MissionStatus, sim_time: float) -> None:
        self._status: MissionStatus = status
        self._throttle = 0.0
        self._brake = 0.0
        self._last_input_at = self._clock()
        self._vehicle: VehicleState | None = None
        self._edge = ""  # last normal (non-junction) road the ambulance entered
        self._planned: PlannedTurn | None = None
        self._queued: Direction | None = None
        self._spawned_at = sim_time
        self._arrived_at: float | None = None

    # ---- lifecycle (engine, simulation thread) ------------------------------
    def on_spawned(self, sim_time: float) -> None:
        self._reset("pending", sim_time)

    def step(self, dt: float) -> None:
        """Apply the speed intent. Call right before simulationStep()."""
        if self._status != "driving" or self._vehicle is None:
            return
        if self._deadman_s is not None and self._clock() - self._last_input_at > self._deadman_s:
            self._throttle = self._brake = 0.0  # input stream lost: coast to a stop
        speed = self._vehicle.speed
        if self._brake > 0:
            target = speed - BRAKE * self._brake * dt
        elif self._throttle > 0:
            target = speed + ACCEL * self._throttle * dt
        else:
            target = speed - COAST * dt
        self._conn.vehicle.setSpeed(AMBULANCE_ID, max(0.0, min(VMAX, target)))

    def observe(self, vehicle: VehicleState | None, sim_time: float) -> None:
        """Track the ambulance after each simulationStep()."""
        if self._status == "none":
            return
        if vehicle is None:
            if self._status != "pending":  # removed by SUMO (e.g. teleported)
                self._reset("none", sim_time)
            return
        self._vehicle = vehicle
        if self._status == "pending":
            self._take_control()
            self._status = "driving"
        if self._status != "driving":
            return
        if not vehicle.edge.startswith(":") and vehicle.edge != self._edge:
            self._enter_edge(vehicle)
        hospital = self._network.hospital.edge
        if vehicle.edge == hospital and self._conn.vehicle.isStopped(AMBULANCE_ID):
            self._status = "arrived"
            self._arrived_at = sim_time

    def status(self, sim_time: float) -> AmbulanceStatus:
        if self._status == "none":
            return AmbulanceStatus("none")
        next_signal = None
        if self._status == "driving":
            upcoming = self._conn.vehicle.getNextTLS(AMBULANCE_ID)
            if upcoming:
                tls_id, link_index, distance, state = upcoming[0]
                next_signal = NextSignal(tls_id, int(link_index), float(distance), state)
        end = self._arrived_at if self._arrived_at is not None else sim_time
        return AmbulanceStatus(
            status=self._status,
            throttle=self._throttle,
            brake=self._brake,
            next_signal=next_signal,
            planned_turn=self._planned,
            queued_turn=self._queued,
            mission_time=end - self._spawned_at,
        )

    # ---- commands (engine, simulation thread) -------------------------------
    def set_drive(self, throttle: float, brake: float) -> None:
        self._throttle = _clamp01(throttle)
        self._brake = _clamp01(brake)
        self._last_input_at = self._clock()

    def request_turn(self, direction: Direction) -> CommandResult:
        problem = self._not_driving()
        if problem:
            return problem
        assert self._vehicle is not None
        hospital = self._network.hospital.edge
        if self._vehicle.edge == hospital:
            return CommandResult(False, "already on the hospital road")
        if not self._vehicle.edge.startswith(":"):
            return self._plan_turn(self._vehicle, direction)
        # Inside a junction: the request is for the junction after it.
        route = self._conn.vehicle.getRoute(AMBULANCE_ID)
        index = self._conn.vehicle.getRouteIndex(AMBULANCE_ID)
        if index + 1 >= len(route) or route[index + 1] == hospital:
            return CommandResult(False, "no junction before the hospital")
        next_edge = self._net.getEdge(route[index + 1])
        junction = next_edge.getToNode().getID()
        if self._choose(next_edge, direction) is None:
            return CommandResult(False, f"no {direction} turn at {junction}")
        self._queued = direction
        return CommandResult(True, f"{direction} turn queued for {junction}")

    def request_lane(self, direction: Direction) -> CommandResult:
        problem = self._not_driving()
        if problem:
            return problem
        vehicle = self._vehicle
        assert vehicle is not None
        if vehicle.edge.startswith(":"):
            return CommandResult(False, "can't change lanes inside a junction")
        edge = self._net.getEdge(vehicle.edge)
        target = vehicle.lane + self._lane_delta(direction)
        if not 0 <= target < edge.getLaneNumber():
            return CommandResult(False, f"no lane further {direction}")
        if not edge.getLane(target).allows("emergency"):
            return CommandResult(False, f"the {_lane_name(edge, target)} is closed")
        planned = self._planned
        if planned is not None:
            exits = self._lanes_to(edge, self._net.getEdge(planned.edge))
            # Leaving the lane the turn needs is fine only with room to come back.
            if target not in exits and self._room_left(vehicle) < 2 * self._room_per_change(
                vehicle
            ):
                return CommandResult(
                    False, f"stay in this lane for the {planned.turn} at {planned.junction}"
                )
        self._conn.vehicle.changeLane(AMBULANCE_ID, target, LANE_CHANGE_HOLD_S)
        lane_state, _ = self._conn.vehicle.getLaneChangeState(AMBULANCE_ID, target - vehicle.lane)
        if lane_state & _LANE_BLOCKED:
            return CommandResult(True, f"waiting for a gap in the {_lane_name(edge, target)}")
        return OK

    # ---- internals -------------------------------------------------------------
    def _not_driving(self) -> CommandResult | None:
        if self._status == "driving" and self._vehicle is not None:
            return None
        if self._status == "arrived":
            return CommandResult(False, "the ambulance has arrived at the hospital")
        if self._status == "pending":
            return CommandResult(False, "the ambulance is still leaving the depot")
        return CommandResult(False, "no ambulance on the road")

    def _take_control(self) -> None:
        self._conn.vehicle.setSpeedMode(AMBULANCE_ID, SPEED_MODE)
        self._conn.vehicle.setLaneChangeMode(AMBULANCE_ID, LANE_CHANGE_MODE)
        self._conn.vehicle.setSpeed(AMBULANCE_ID, 0.0)

    def _enter_edge(self, vehicle: VehicleState) -> None:
        self._edge = vehicle.edge
        self._planned = None
        if vehicle.edge == self._network.hospital.edge:
            self._park_at_hospital()
            return
        queued, self._queued = self._queued, None
        if queued is not None and self._plan_turn(vehicle, queued).ok:
            return
        self._plan_turn(vehicle, None)  # default: straight on (U-turn at the map edge)

    def _plan_turn(self, vehicle: VehicleState, direction: Direction | None) -> CommandResult:
        edge = self._net.getEdge(vehicle.edge)
        junction = edge.getToNode().getID()
        choice = self._choose(edge, direction)
        if choice is None:
            what = f"{direction} turn" if direction else "way on"
            return CommandResult(False, f"no {what} at {junction}")
        turn, target = choice
        if direction is not None:
            exits = self._lanes_to(edge, target)
            if vehicle.lane not in exits:
                changes = min(abs(vehicle.lane - lane) for lane in exits)
                room = self._room_left(vehicle)
                if room < changes * self._room_per_change(vehicle):
                    lane = _lane_name(edge, min(exits, key=lambda i: abs(vehicle.lane - i)))
                    return CommandResult(
                        False,
                        f"too late to turn {direction} at {junction}: "
                        f"needs the {lane}, only {room:.0f} m left",
                    )
        try:
            self._conn.vehicle.setRoute(AMBULANCE_ID, [edge.getID(), target.getID()])
        except TraCIException as exc:
            return CommandResult(False, f"SUMO refused the route: {exc}")
        self._planned = PlannedTurn(junction, turn, target.getID())
        return OK

    def _choose(self, edge: Edge, direction: Direction | None) -> tuple[TurnKind, Edge] | None:
        """Pick the road after the junction for a direction, or the default (None)."""
        heading_in = _heading(edge, at_end=True)
        turns: list[tuple[float, Edge]] = []
        uturn: Edge | None = None
        for out in edge.getOutgoing():
            if not out.allows("emergency"):
                continue
            if out.getToNode() == edge.getFromNode():
                uturn = out
            else:
                turns.append((_signed_turn(heading_in, _heading(out, at_end=False)), out))
        if direction == "left":
            lefts = [t for t in turns if t[0] > TURN_MIN_DEG]
            return ("left", max(lefts, key=lambda t: t[0])[1]) if lefts else None
        if direction == "right":
            rights = [t for t in turns if t[0] < -TURN_MIN_DEG]
            return ("right", min(rights, key=lambda t: t[0])[1]) if rights else None
        if turns:
            angle, best = min(turns, key=lambda t: abs(t[0]))
            if abs(angle) <= TURN_MIN_DEG:
                return ("straight", best)
            return ("left" if angle > 0 else "right", best)
        return ("uturn", uturn) if uturn is not None else None

    def _park_at_hospital(self) -> None:
        hospital = self._network.hospital
        self._conn.vehicle.setRoute(AMBULANCE_ID, [hospital.edge])
        self._conn.vehicle.setStop(
            AMBULANCE_ID, hospital.edge, pos=hospital.pos, laneIndex=0, duration=1e6
        )

    def _lane_delta(self, direction: Direction) -> int:
        """Lane 0 is the curb lane: on the left in left-hand traffic, else on the right."""
        toward_curb = (direction == "left") == self._network.lefthand
        return -1 if toward_curb else 1

    @staticmethod
    def _lanes_to(edge: Edge, target: Edge) -> set[int]:
        return {c.getFromLane().getIndex() for c in edge.getOutgoing().get(target, [])}

    def _room_left(self, vehicle: VehicleState) -> float:
        lane = self._net.getEdge(vehicle.edge).getLane(vehicle.lane)
        return float(lane.getLength()) - self._conn.vehicle.getLanePosition(AMBULANCE_ID)

    @staticmethod
    def _room_per_change(vehicle: VehicleState) -> float:
        return max(LANE_CHANGE_ROOM_M, vehicle.speed * LANE_CHANGE_TIME_S)


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


def _lane_name(edge: Edge, index: int) -> str:
    if index == 0:
        return "curb lane"
    if index == edge.getLaneNumber() - 1:
        return "inner lane"
    return f"lane {index}"


def _heading(edge: Edge, at_end: bool) -> float:
    shape = edge.getShape()
    (x1, y1), (x2, y2) = (shape[-2][:2], shape[-1][:2]) if at_end else (shape[0][:2], shape[1][:2])
    return math.atan2(y2 - y1, x2 - x1)


def _signed_turn(a: float, b: float) -> float:
    d = b - a
    return math.degrees(math.atan2(math.sin(d), math.cos(d)))  # + = left (counter-clockwise)

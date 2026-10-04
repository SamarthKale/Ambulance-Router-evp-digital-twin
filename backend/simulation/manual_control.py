"""Manual ambulance control (v1).

Keyboard = intent. SUMO stays authoritative: we only nudge target speed,
pick the next edge at junctions, and request lane changes.

Only traci calls live here (see CLAUDE.md: no traci outside simulation/).
Signal changes are NOT done here; they go through safety/controller.py.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass

import sumolib
import traci

ACCEL = 3.5          # m/s^2 at full throttle
BRAKE = 6.0          # m/s^2 at full brake
COAST = 1.0          # m/s^2 natural slowdown with no input
VMAX = 22.0          # m/s (~80 km/h) cap for the ambulance
TURN_MIN_DEG = 20.0  # minimum angle to count as a left/right turn
DEADMAN_S = 0.5      # zero the input if no drive message arrives in this time


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


@dataclass
class ManualInput:
    throttle: float = 0.0
    brake: float = 0.0


class ManualController:
    def __init__(self, net: sumolib.net.Net, vehicle_id: str) -> None:
        self.net = net
        self.vid = vehicle_id
        self.input = ManualInput()
        self._last_input_ts = time.monotonic()
        self._last_edge: str | None = None

    # ---- lifecycle -------------------------------------------------------
    def take_control(self) -> None:
        traci.vehicle.setSpeedMode(self.vid, 31)  # keep safe-speed + red-light rules
        traci.vehicle.setSpeed(self.vid, 0.0)

    def release(self) -> None:
        traci.vehicle.setSpeed(self.vid, -1)  # hand speed back to SUMO

    # ---- per-step update (call before traci.simulationStep()) ------------
    def step(self, dt: float) -> None:
        if self.vid not in traci.vehicle.getIDList():
            return
        if time.monotonic() - self._last_input_ts > DEADMAN_S:
            self.input = ManualInput()  # lost connection: coast to a stop
        self._update_speed(dt)
        self._default_straight_on_new_edge()

    def _update_speed(self, dt: float) -> None:
        v = traci.vehicle.getSpeed(self.vid)
        if self.input.brake > 0:
            target = v - BRAKE * self.input.brake * dt
        elif self.input.throttle > 0:
            target = v + ACCEL * self.input.throttle * dt
        else:
            target = v - COAST * dt
        traci.vehicle.setSpeed(self.vid, max(0.0, min(VMAX, target)))

    # ---- commands from the WebSocket -------------------------------------
    def handle(self, msg: dict) -> bool:
        """Returns False only when a requested turn is impossible."""
        cmd = msg.get("cmd")
        if cmd == "drive":
            c = msg.get("control", {})
            self.input = ManualInput(_clamp01(c.get("throttle", 0)), _clamp01(c.get("brake", 0)))
            self._last_input_ts = time.monotonic()
        elif cmd == "turn":
            return self.turn(msg.get("direction", "straight"))
        elif cmd == "lane":
            self.change_lane(1 if msg.get("direction") == "left" else -1)
        return True

    def change_lane(self, delta: int) -> None:
        edge = traci.vehicle.getRoadID(self.vid)
        if edge.startswith(":"):
            return
        lane = traci.vehicle.getLaneIndex(self.vid) + delta  # lane 0 = rightmost
        if 0 <= lane < traci.edge.getLaneNumber(edge):
            traci.vehicle.changeLane(self.vid, lane, 3.0)

    # ---- turn logic ------------------------------------------------------
    def turn(self, direction: str) -> bool:
        edge = traci.vehicle.getRoadID(self.vid)
        if edge.startswith(":"):
            return False  # already inside the junction
        return self._set_next(edge, direction)

    def _default_straight_on_new_edge(self) -> None:
        edge = traci.vehicle.getRoadID(self.vid)
        if edge.startswith(":") or edge == self._last_edge:
            return
        self._last_edge = edge
        self._set_next(edge, "straight")

    def _set_next(self, edge_id: str, direction: str) -> bool:
        cur = self.net.getEdge(edge_id)
        options = [e for e in cur.getOutgoing() if e.getToNode() != cur.getFromNode()]  # no U-turns
        if not options:
            self._stop_at_dead_end(edge_id)
            return False

        din = self._heading(cur, end=True)
        scored = [(self._signed_turn(din, self._heading(e, end=False)), e) for e in options]

        if direction == "left":
            pool = [s for s in scored if s[0] > TURN_MIN_DEG]
            choice = max(pool, key=lambda s: s[0]) if pool else None
        elif direction == "right":
            pool = [s for s in scored if s[0] < -TURN_MIN_DEG]
            choice = min(pool, key=lambda s: s[0]) if pool else None
        else:
            choice = min(scored, key=lambda s: abs(s[0]))
        if choice is None:
            return False  # no such turn at this junction

        try:
            traci.vehicle.setRoute(self.vid, [edge_id, choice[1].getID()])
        except traci.TraCIException:
            return False
        return True

    def _stop_at_dead_end(self, edge_id: str) -> None:
        try:
            length = traci.lane.getLength(f"{edge_id}_0")
            traci.vehicle.setStop(self.vid, edge_id, pos=length - 0.5, laneIndex=0, duration=3600)
        except traci.TraCIException:
            pass

    @staticmethod
    def _heading(edge: sumolib.net.edge.Edge, end: bool) -> float:
        shape = edge.getShape()
        (x1, y1), (x2, y2) = (shape[-2][:2], shape[-1][:2]) if end else (shape[0][:2], shape[1][:2])
        return math.atan2(y2 - y1, x2 - x1)

    @staticmethod
    def _signed_turn(a: float, b: float) -> float:
        d = b - a
        return math.degrees(math.atan2(math.sin(d), math.cos(d)))  # + = left (CCW)

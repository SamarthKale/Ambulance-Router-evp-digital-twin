"""Protocol v1 message models (CLAUDE.md section 9).

Mirrors frontend/src/simulation/state.ts: change both in the same commit, and bump
PROTOCOL_VERSION for breaking changes. JSON field names are camelCase.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from pydantic.alias_generators import to_camel

from simulation.engine import ChangeLane, Command, Drive, EngineState, Reset, SpawnAmbulance, Turn
from simulation.vehicle import AMBULANCE_ID

PROTOCOL_VERSION = 1

Direction = Literal["left", "right"]


class Message(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, serialize_by_alias=True, frozen=True
    )


# ---- frontend -> backend --------------------------------------------------------
class _Command(BaseModel):
    model_config = ConfigDict(extra="forbid")
    v: Literal[1]


class SpawnAmbulanceCmd(_Command):
    id: int
    cmd: Literal["spawn_ambulance"]


class DriveControl(BaseModel):
    model_config = ConfigDict(extra="forbid")
    throttle: float = Field(ge=0, le=1)
    brake: float = Field(ge=0, le=1)


class DriveCmd(_Command):
    """Sent on every key change plus a 10 Hz heartbeat; never acknowledged."""

    cmd: Literal["drive"]
    vehicle: str
    control: DriveControl


class TurnCmd(_Command):
    id: int
    cmd: Literal["turn"]
    vehicle: str
    direction: Direction


class LaneCmd(_Command):
    id: int
    cmd: Literal["lane"]
    vehicle: str
    direction: Direction


class ResetCmd(_Command):
    id: int
    cmd: Literal["reset"]


ClientCommand = Annotated[
    SpawnAmbulanceCmd | DriveCmd | TurnCmd | LaneCmd | ResetCmd, Field(discriminator="cmd")
]
CLIENT_COMMAND: TypeAdapter[ClientCommand] = TypeAdapter(ClientCommand)


def to_engine_command(cmd: ClientCommand) -> Command:
    match cmd:
        case SpawnAmbulanceCmd():
            return SpawnAmbulance()
        case DriveCmd(control=control):
            return Drive(control.throttle, control.brake)
        case TurnCmd(direction=direction):
            return Turn(direction)
        case LaneCmd(direction=direction):
            return ChangeLane(direction)
        case ResetCmd():
            return Reset()


# ---- backend -> frontend --------------------------------------------------------
class AckMsg(Message):
    v: Literal[1] = 1
    type: Literal["ack"] = "ack"
    id: int
    ok: bool
    reason: str = ""


class ErrorMsg(Message):
    """Reply to a message that could not even be read as a command with an id."""

    v: Literal[1] = 1
    type: Literal["error"] = "error"
    reason: str


class VehicleMsg(Message):
    id: str
    type: str  # vType id = 3D asset key
    x: float  # m, vehicle centre, SUMO coordinates
    y: float
    angle: float  # deg clockwise from north
    speed: float  # m/s
    edge: str
    lane: int  # 0 = curb lane


class SignalMsg(Message):
    id: str
    state: str  # one SUMO char per link (G g y r ...); index = link index
    phase: int
    preempted: bool = False


class NextSignalMsg(Message):
    junction: str
    distance: float
    state: str  # the ambulance's own link


class PlannedTurnMsg(Message):
    junction: str
    turn: Literal["left", "straight", "right", "uturn"]
    edge: str


class AmbulanceMsg(Message):
    id: str = AMBULANCE_ID
    status: Literal["none", "pending", "driving", "arrived"]
    throttle: float = 0.0  # input applied by the backend (after the deadman timer)
    brake: float = 0.0
    next_signal: NextSignalMsg | None = None
    planned_turn: PlannedTurnMsg | None = None
    queued_turn: Direction | None = None
    mission_time: float | None = None


class MetricsMsg(Message):
    eta: float | None = None  # Sprint 6
    signals_preempted: int = 0  # Sprint 3
    queue_cleared: int | None = None  # Sprint 7
    time_saved: float | None = None  # only ever measured (ghost run, Sprint 9)


class StateMsg(Message):
    v: Literal[1] = 1
    type: Literal["state"] = "state"
    seq: int
    t: float
    mode: Literal["OFF", "BASIC", "COORD"]
    vehicles: list[VehicleMsg]
    signals: list[SignalMsg]
    ambulance: AmbulanceMsg
    route: None = None  # Sprint 6
    metrics: MetricsMsg = MetricsMsg()
    incidents: list[str] = []  # Sprint 8


def state_message(state: EngineState) -> StateMsg:
    snap, amb = state.snapshot, state.ambulance
    return StateMsg(
        seq=state.seq,
        t=round(snap.time, 3),
        mode=state.mode,  # type: ignore[arg-type]
        vehicles=[
            VehicleMsg(
                id=v.id,
                type=v.type,
                x=round(v.x, 2),
                y=round(v.y, 2),
                angle=round(v.angle, 1),
                speed=round(v.speed, 2),
                edge=v.edge,
                lane=v.lane,
            )
            for v in snap.vehicles
        ],
        signals=[SignalMsg(id=s.tls_id, state=s.state, phase=s.phase) for s in snap.signals],
        ambulance=AmbulanceMsg(
            status=amb.status,
            throttle=amb.throttle,
            brake=amb.brake,
            next_signal=(
                NextSignalMsg(
                    junction=amb.next_signal.junction,
                    distance=round(amb.next_signal.distance, 1),
                    state=amb.next_signal.state,
                )
                if amb.next_signal
                else None
            ),
            planned_turn=(
                PlannedTurnMsg(
                    junction=amb.planned_turn.junction,
                    turn=amb.planned_turn.turn,
                    edge=amb.planned_turn.edge,
                )
                if amb.planned_turn
                else None
            ),
            queued_turn=amb.queued_turn,
            mission_time=None if amb.mission_time is None else round(amb.mission_time, 1),
        ),
    )


# ---- GET /api/network ---------------------------------------------------------------
Point = tuple[float, float]


class LaneMsg(Message):
    id: str
    edge: str
    index: int
    width: float
    shape: list[Point]


class JunctionMsg(Message):
    id: str
    type: str
    shape: list[Point]


class LinkMsg(Message):
    index: int
    from_lane: str
    to_lane: str
    dir: str  # s, l, r, t (U-turn), ...
    approach: str  # incoming edge


class SignalLinksMsg(Message):
    id: str
    links: list[LinkMsg]


class PlaceMsg(Message):
    edge: str
    pos: float
    x: float
    y: float


class NetworkMsg(Message):
    v: Literal[1] = 1
    lefthand: bool
    bounds: tuple[float, float, float, float]  # xmin, ymin, xmax, ymax
    lanes: list[LaneMsg]
    junctions: list[JunctionMsg]
    signals: list[SignalLinksMsg]
    depot: PlaceMsg
    hospital: PlaceMsg


class HealthMsg(Message):
    status: Literal["starting", "running", "error"]
    error: str | None = None
    seq: int | None = None
    t: float | None = None

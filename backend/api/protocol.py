"""Protocol v1 message models (CLAUDE.md section 9).

Mirrors frontend/src/simulation/state.ts: change both in the same commit, and bump
PROTOCOL_VERSION for breaking changes. JSON field names are camelCase.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from pydantic.alias_generators import to_camel

from simulation.engine import (
    ChangeLane,
    Command,
    Drive,
    EngineState,
    Reset,
    RouteStatus,
    SetMode,
    SpawnAmbulance,
    Turn,
)
from simulation.vehicle import AMBULANCE_ID

PROTOCOL_VERSION = 1

Direction = Literal["left", "right"]
Mode = Literal["OFF", "BASIC", "COORD"]


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


class SetModeCmd(_Command):
    id: int
    cmd: Literal["set_mode"]
    mode: Mode


class ResetCmd(_Command):
    id: int
    cmd: Literal["reset"]


class HelloCmd(_Command):
    """First message on every (re)connect: the tab's id, so a reconnecting driver keeps
    control. Answered with a session message, not an ack."""

    cmd: Literal["hello"]
    client_id: str = Field(alias="clientId", min_length=8, max_length=64, pattern=r"^[\w-]+$")


class ReleaseControlCmd(_Command):
    id: int
    cmd: Literal["release_control"]


ClientCommand = Annotated[
    SpawnAmbulanceCmd
    | DriveCmd
    | TurnCmd
    | LaneCmd
    | SetModeCmd
    | ResetCmd
    | HelloCmd
    | ReleaseControlCmd,
    Field(discriminator="cmd"),
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
        case SetModeCmd(mode=mode):
            return SetMode(mode)
        case ResetCmd():
            return Reset()
        case HelloCmd() | ReleaseControlCmd():
            raise ValueError(f"'{cmd.cmd}' is a session command, not an engine command")


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


class SessionMsg(Message):
    """Sent to a client on connect, on hello and whenever the driver changes."""

    v: Literal[1] = 1
    type: Literal["session"] = "session"
    client_id: str  # how the server knows this client (its hello id, or a server id)
    role: Literal["driver", "observer", "free"]  # free: nobody drives; dispatch to take control


class VehicleMsg(Message):
    id: str
    type: str  # vType id = 3D asset key
    x: float  # m, vehicle centre, SUMO coordinates
    y: float
    angle: float  # deg clockwise from north
    speed: float  # m/s
    edge: str
    lane: int  # 0 = curb lane


SignalControl = Literal["program", "clearing", "preempted", "recovering"]


class SignalMsg(Message):
    id: str
    state: str  # one SUMO char per link (G g y r ...); index = link index
    phase: int  # phase of the normal program (meaningless while not under program control)
    preempted: bool = False  # the safety controller (not the normal program) drives it
    control: SignalControl = "program"


class NextSignalMsg(Message):
    junction: str
    link_index: int
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


class RouteTurnMsg(Message):
    junction: str
    turn: Literal["left", "straight", "right", "uturn"]
    edge: str  # road taken after the junction


class RouteMsg(Message):
    """Suggested route to the hospital (advisory: it never steers a manually driven ambulance)."""

    edges: list[str]  # from the ambulance's road (or the one after its junction) to the hospital
    turns: list[RouteTurnMsg]  # junction by junction
    eta: float  # s, predicted, counted down between re-plans
    distance: float  # m remaining along the route
    follows: bool  # the road the ambulance will take next is the suggested one
    routing: Literal["dynamic", "static"]
    computed_at: float  # simulation time of the plan
    drive: float  # s of the plan's ETA spent driving...
    queue: float  # ...waiting for queues to discharge...
    signal: float  # ...and waiting at red lights


class MetricsMsg(Message):
    eta: float | None = None  # s to the hospital along the suggested route
    signals_preempted: int = 0  # preemptions that reached green, since the simulation started
    queue_cleared: int | None = None  # Sprint 7
    time_saved: float | None = None  # only ever measured (ghost run, Sprint 9)


class SafetyEventMsg(Message):
    t: float
    junction: str
    vehicle: str | None
    action: str  # preempt, green, release, timeout, resume, fail_safe
    accepted: bool
    reason: str


class SafetyMsg(Message):
    violations: int  # independent monitor; must stay 0
    collisions: int  # SUMO-detected
    events: list[SafetyEventMsg]  # safety controller decisions, most recent last


class StateMsg(Message):
    v: Literal[1] = 1
    type: Literal["state"] = "state"
    seq: int
    t: float
    mode: Mode
    vehicles: list[VehicleMsg]
    signals: list[SignalMsg]
    ambulance: AmbulanceMsg
    route: RouteMsg | None = None
    metrics: MetricsMsg = MetricsMsg()
    safety: SafetyMsg
    incidents: list[str] = []  # Sprint 8


def route_message(route: RouteStatus | None) -> RouteMsg | None:
    if route is None:
        return None
    plan = route.plan
    return RouteMsg(
        edges=list(route.edges),
        turns=[RouteTurnMsg(junction=t.junction, turn=t.turn, edge=t.edge) for t in route.turns],
        eta=round(route.eta_s, 1),
        distance=round(route.distance_m, 1),
        follows=route.follows,
        routing=route.routing,
        computed_at=round(plan.computed_at, 3),
        drive=round(plan.drive_s, 1),
        queue=round(plan.queue_s, 1),
        signal=round(plan.signal_s, 1),
    )


def state_message(state: EngineState) -> StateMsg:
    snap, amb, safety = state.snapshot, state.ambulance, state.safety
    route = route_message(state.route)
    return StateMsg(
        seq=state.seq,
        t=round(snap.time, 3),
        mode=state.mode,
        route=route,
        metrics=MetricsMsg(
            eta=route.eta if route else None, signals_preempted=safety.signals_preempted
        ),
        safety=SafetyMsg(
            violations=safety.violations,
            collisions=safety.collisions,
            events=[
                SafetyEventMsg(
                    t=e.time,
                    junction=e.junction,
                    vehicle=e.vehicle,
                    action=e.action,
                    accepted=e.accepted,
                    reason=e.reason,
                )
                for e in safety.events
            ],
        ),
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
        signals=[
            SignalMsg(
                id=s.tls_id,
                state=s.state,
                phase=s.phase,
                preempted=safety.stages.get(s.tls_id, "program") != "program",
                control=safety.stages.get(s.tls_id, "program"),
            )
            for s in snap.signals
        ],
        ambulance=AmbulanceMsg(
            status=amb.status,
            throttle=amb.throttle,
            brake=amb.brake,
            next_signal=(
                NextSignalMsg(
                    junction=amb.next_signal.junction,
                    link_index=amb.next_signal.link_index,
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
    vehicles: int = 0
    tick_ms_p50: float | None = None  # engine tick, last 30 s (budget: 100 ms at 10 Hz)
    tick_ms_p95: float | None = None
    tick_ms_max: float | None = None
    sumo_step_ms_p50: float | None = None

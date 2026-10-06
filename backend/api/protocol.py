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
    ClearIncidents,
    Command,
    Drive,
    EngineState,
    InjectAccident,
    Reset,
    RouteStatus,
    SetMode,
    SpawnAmbulance,
    Turn,
)
from simulation.ghost import GhostStatus
from simulation.incidents import Incident, is_wreck
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


class InjectIncidentCmd(_Command):
    """An accident blocks one lane mid-way along a road. Without an edge: the road after the
    ambulance's next junction on the suggested route."""

    id: int
    cmd: Literal["inject_incident"]
    type: Literal["accident"]
    edge: str | None = None


class ClearIncidentsCmd(_Command):
    id: int
    cmd: Literal["clear_incidents"]


ClientCommand = Annotated[
    SpawnAmbulanceCmd
    | DriveCmd
    | TurnCmd
    | LaneCmd
    | SetModeCmd
    | ResetCmd
    | HelloCmd
    | ReleaseControlCmd
    | InjectIncidentCmd
    | ClearIncidentsCmd,
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
        case InjectIncidentCmd(edge=edge):
            return InjectAccident(edge)
        case ClearIncidentsCmd():
            return ClearIncidents()
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
    # An accident hit the route: shown for a while after the re-plan, and as long as the
    # route still runs through it.
    compromised: bool = False
    compromised_by: str | None = None  # the road with the accident
    eta_change: float | None = None  # s, new ETA minus the ETA just before the accident
    blocked_ahead: bool = False  # the route still passes an accident (no faster way round)


class MetricsMsg(Message):
    eta: float | None = None  # s to the hospital along the suggested route
    signals_preempted: int = 0  # preemptions that reached green, since the simulation started
    # This mission: junctions whose waiting queue was gone before the ambulance got there
    # (preempted with a queue in front, crossed without stopping on that approach).
    queue_cleared: int | None = None
    time_saved: float | None = None  # s, measured: OFF ghost's mission time minus this one


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


class IncidentMsg(Message):
    id: str
    type: Literal["accident"]
    edge: str
    lane: int  # 0 = curb lane
    x: float  # m, SUMO coordinates of the wreck
    y: float
    angle: float  # deg clockwise from north, along the road
    since: float  # simulation time


class GhostPoseMsg(Message):
    t: float  # simulation time of this pose (at most the state's t)
    x: float  # m, vehicle centre, SUMO coordinates
    y: float
    angle: float
    speed: float
    edge: str


class GhostMsg(Message):
    """The OFF ghost: the same mission replayed with normal signals and the autopilot."""

    phase: Literal["driving", "arrived", "unavailable"]
    pose: GhostPoseMsg | None = None
    mission_time: float | None = None  # the ghost's, once it has arrived
    reason: str = ""  # why there is no ghost for this mission


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
    incidents: list[IncidentMsg] = []  # wrecks are drawn from here, not from vehicles
    ghost: GhostMsg | None = None  # null before the dispatch (and without a ghost)


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
        drive=round(plan.drive_s - plan.incident_s, 1),
        queue=round(plan.queue_s, 1),
        signal=round(plan.signal_s, 1),
        compromised=route.compromised_by is not None,
        compromised_by=route.compromised_by,
        eta_change=route.eta_change_s,
        blocked_ahead=route.blocked_ahead,
    )


def ghost_message(ghost: GhostStatus | None) -> GhostMsg | None:
    if ghost is None or ghost.phase == "shadowing":
        return None
    pose = ghost.pose
    return GhostMsg(
        phase=ghost.phase,
        pose=(
            GhostPoseMsg(
                t=round(pose.t, 3),
                x=round(pose.x, 2),
                y=round(pose.y, 2),
                angle=round(pose.angle, 1),
                speed=round(pose.speed, 2),
                edge=pose.edge,
            )
            if pose is not None
            else None
        ),
        mission_time=None if ghost.mission_time is None else round(ghost.mission_time, 1),
        reason=ghost.reason,
    )


def incident_message(incident: Incident) -> IncidentMsg:
    return IncidentMsg(
        id=incident.id,
        type="accident",
        edge=incident.edge,
        lane=incident.lane,
        x=incident.x,
        y=incident.y,
        angle=incident.angle,
        since=incident.since,
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
            eta=route.eta if route else None,
            signals_preempted=safety.signals_preempted,
            queue_cleared=state.queues_cleared if amb.status != "none" else None,
            time_saved=state.time_saved_s,
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
            if not is_wreck(v.id)
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
        incidents=[incident_message(i) for i in state.incidents],
        ghost=ghost_message(state.ghost),
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


# ---- GET /api/results (experiments/summary/summary.json, Sprint 9) -----------------------
class PairedMsg(Message):
    """An arm minus the baseline over the same seeds."""

    n: int  # seed pairs used (pairs with an invalid run are excluded)
    mean_diff: float | None
    ci: tuple[float | None, float | None]  # 95 % bootstrap interval of the mean difference
    p: float | None  # Wilcoxon signed-rank, two-sided, exact


class ResultSafetyMsg(Message):
    violations: int
    collisions: int
    emergency_brakings: int
    teleports: int
    # collision events naming the ambulance (scripts.classify_collisions); null: not checked
    ambulance_collisions: int | None = None


class ResultArmMsg(Message):
    arm: str  # e.g. "basic_dynamic"
    label: str
    signals: Literal["off_strict", "off_realistic", "basic", "coord"]
    routing: Literal["static", "dynamic"]
    runs: int
    valid: int
    travel_mean: float | None  # s, valid runs
    travel_ci: tuple[float | None, float | None]
    wait_mean: float | None
    safety: ResultSafetyMsg  # summed over the runs
    travel_vs_baseline: PairedMsg | None  # null for the baseline itself
    bg_delay_vs_baseline: PairedMsg | None  # background time loss, veh-s


class ResultExperimentMsg(Message):
    scenario: str
    scale: float
    seeds: list[int]
    pairing_ok: bool  # every arm of a seed started from the same traffic
    signal_program: Literal["tuned", "net"]
    cycle_s: float | None  # mean cycle of the base signal program
    arms: list[ResultArmMsg]


class ResultsMsg(Message):
    """Batch experiment results (autopilot runs), for the in-app comparison chart."""

    available: bool  # false until scripts.run_experiments has written a summary
    generated_at: str | None = None
    note: str = ""
    baseline: str = ""
    experiments: list[ResultExperimentMsg] = []
    charts: list[str] = []  # PNG charts, served at /api/charts/<name>


# ---- GET /api/replay/... (Sprint 11: recorded experiment runs, played back) -----------------
ReplayStrategy = Literal["off_strict", "off_realistic", "basic", "coord"]
ReplayRouting = Literal["static", "dynamic"]


class ReplaySummaryMsg(Message):
    """One run's authoritative result: its row in experiments/<arm>/runs.csv (blank = null)."""

    origin: str
    destination: str
    dispatch_s: float | None  # simulation time of the dispatch
    trip_m: float | None  # length of the shortest route between origin and destination
    arrived: bool
    valid: bool  # arrived and no teleport (invalid runs are excluded from the statistics)
    signal_program: str  # "tuned" or "net"
    cycle_s: float | None
    travel_s: float | None
    wait_s: float | None
    stops: int | None
    red_stops: int | None
    red_crossings: int | None
    approach_clear_s: float | None
    queue_mean: float | None
    bg_time_loss_s: float | None
    preemptions: int | None
    route_changes: int | None
    violations: int | None  # independent monitor
    collisions: int | None  # SUMO-reported, whole 600 s window (any vehicles)
    emergency_brakings: int | None  # SUMO log, after the dispatch (any vehicles)
    teleports: int | None
    ambulance_collisions: int | None  # null: not classified (scripts.classify_collisions)


class ReplayIndexRunMsg(Message):
    id: str  # "<arm>/<run key>", e.g. basic_static/grid4x4_x1.5_seed001
    scenario: str
    scale: float
    seed: int
    arm: str
    strategy: ReplayStrategy
    routing: ReplayRouting
    summary: ReplaySummaryMsg
    telemetry: bool  # a playback was recorded for this run
    matches_recorded: bool | None  # its re-run reproduced the runs.csv row (null: no telemetry)
    traffic: bool  # the background traffic was recorded too
    differences: list[str] = []


class ReplayIndexMsg(Message):
    v: Literal[1] = 1
    available: bool  # false until scripts.run_experiments has written runs
    note: str = ""
    runs: list[ReplayIndexRunMsg] = []


class ReplayRouteMsg(Message):
    t: float  # s since the dispatch
    edges: list[str]  # the suggested route from the ambulance's road to the hospital
    eta: float
    routing: ReplayRouting


class ReplaySignalsMsg(Message):
    ids: list[str]
    initial: list[str]  # SUMO state string per signal at t = 0
    initial_control: list[SignalControl]
    # [t, signal index, state string, controller stage]: only when one of them changed
    changes: list[tuple[float, int, str, SignalControl]]


class ReplayEventMsg(Message):
    t: float
    kind: str  # dispatch, preempt, green, release, timeout, resume, fail_safe, route_review,
    # reroute, accident, collision, violation, arrival
    junction: str | None = None
    edge: str | None = None
    text: str = ""
    accepted: bool | None = None  # controller decisions only


class ReplayEdgeSampleMsg(Message):
    t: float
    halting: list[int]  # per road, in ReplayEdgesMsg.ids order
    vehicles: list[int]
    speed: list[float]  # mean speed, m/s


class ReplayEdgesMsg(Message):
    ids: list[str]
    interval_s: float
    samples: list[ReplayEdgeSampleMsg]


class ReplayTrafficMsg(Message):
    interval_s: float
    ids: list[str]  # vehicle ids, indexed by the first value of each quad
    types: list[str]  # vType per id
    # [t, [id index, x, y, angle, id index, x, y, angle, ...]]
    samples: list[tuple[float, list[float]]]


class ReplayVerificationMsg(Message):
    matches_recorded: bool
    checked: int
    differences: list[str]


class ReplayProvenanceMsg(Message):
    git_sha: str
    git_dirty: bool
    sumo_version: str
    created_at: str


class ReplayRunMsg(Message):
    """One recorded run played back: everything is what the simulation reported; times are
    seconds since the dispatch."""

    v: Literal[1] = 1
    schema_version: int
    id: str
    scenario: str
    scale: float
    seed: int
    arm: str
    strategy: ReplayStrategy
    routing: ReplayRouting
    dispatch_s: float
    duration_s: float  # recorded time after the dispatch
    arrived: bool
    mission_time: float | None
    ambulance_edges: list[str]  # road ids referenced by the track
    # [t, x, y, angle, speed, road index (ambulance_edges), lane]
    ambulance: list[tuple[float, float, float, float, float, int, int]]
    # [t, ETA s, metres to go, next signal, its state for the ambulance]; null when not reported
    status: list[tuple[float, float | None, float | None, str | None, str | None]]
    routes: list[ReplayRouteMsg]  # the suggestion at t = 0 and each time it changed
    signals: ReplaySignalsMsg
    events: list[ReplayEventMsg]
    edges: ReplayEdgesMsg
    traffic: ReplayTrafficMsg | None = None  # null: the traffic was not recorded
    incidents: list[IncidentMsg] = []  # none in the Sprint 9 batch (no accidents injected)
    summary: ReplaySummaryMsg | None = None  # null: the run is missing from runs.csv
    verification: ReplayVerificationMsg
    recorded_with: ReplayProvenanceMsg


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

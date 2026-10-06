"""Generate frontend/src/simulation/contract.fixtures.ts from the backend's protocol models.

The fixtures are real serialisations of backend/api/protocol.py models. Each one is
declared `satisfies <Type>` against the hand-written types in state.ts, so TypeScript
fails to compile when the two sides drift (missing, extra or mistyped fields).
tests/test_contract.py fails when this file is out of date.

    .venv\\Scripts\\python.exe -m scripts.gen_contract
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, get_args

from pydantic import BaseModel

from api.protocol import (
    CLIENT_COMMAND,
    AckMsg,
    AmbulanceMsg,
    ClientCommand,
    ErrorMsg,
    GhostMsg,
    GhostPoseMsg,
    HealthMsg,
    IncidentMsg,
    MetricsMsg,
    NetworkMsg,
    NextSignalMsg,
    PairedMsg,
    PlannedTurnMsg,
    ReplayIndexMsg,
    ReplayRunMsg,
    ResultArmMsg,
    ResultExperimentMsg,
    ResultSafetyMsg,
    ResultsMsg,
    RouteMsg,
    RouteTurnMsg,
    SafetyEventMsg,
    SafetyMsg,
    SessionMsg,
    SignalMsg,
    StateMsg,
    VehicleMsg,
)
from simulation.network import RoadNetwork
from simulation.sumo import REPO_ROOT

OUTPUT = REPO_ROOT / "frontend" / "src" / "simulation" / "contract.fixtures.ts"
NETWORK_DIR = REPO_ROOT / "frontend" / "src" / "components" / "fixtures"
NETWORK_SCENARIOS = ("grid2x2", "grid4x4")
SERVER_TYPES = ("state", "ack", "error", "session")  # every message on /ws, server -> client


def command_names() -> list[str]:
    union = get_args(get_args(ClientCommand)[0])
    return [get_args(model.model_fields["cmd"].annotation)[0] for model in union]


def literal_values(model: type[BaseModel], field: str) -> list[str]:
    """Allowed values of a Literal field (Optional unwrapped)."""
    annotation = model.model_fields[field].annotation
    values: list[str] = []
    for arg in get_args(annotation) or (annotation,):
        values += [v for v in (get_args(arg) or (arg,)) if isinstance(v, str)]
    return values


# Enumerations both sides must agree on exactly (a new value on one side breaks the build).
ENUMS: dict[str, tuple[type[BaseModel], str]] = {
    "role": (SessionMsg, "role"),
    "mode": (StateMsg, "mode"),
    "signalControl": (SignalMsg, "control"),
    "missionStatus": (AmbulanceMsg, "status"),
    "turn": (PlannedTurnMsg, "turn"),
    "healthStatus": (HealthMsg, "status"),
    "routing": (RouteMsg, "routing"),
    "incidentType": (IncidentMsg, "type"),
    "ghostPhase": (GhostMsg, "phase"),
    "resultSignals": (ResultArmMsg, "signals"),
    "signalProgram": (ResultExperimentMsg, "signal_program"),
}


def command_examples() -> list[dict[str, Any]]:
    examples = [
        {"v": 1, "id": 1, "cmd": "spawn_ambulance"},
        {"v": 1, "cmd": "drive", "vehicle": "ambulance_01",
         "control": {"throttle": 1.0, "brake": 0.0}},
        {"v": 1, "id": 2, "cmd": "turn", "vehicle": "ambulance_01", "direction": "left"},
        {"v": 1, "id": 3, "cmd": "lane", "vehicle": "ambulance_01", "direction": "right"},
        {"v": 1, "id": 4, "cmd": "set_mode", "mode": "BASIC"},
        {"v": 1, "id": 5, "cmd": "reset"},
        {"v": 1, "cmd": "hello", "clientId": "tab-0123456789"},
        {"v": 1, "id": 6, "cmd": "release_control"},
        {"v": 1, "id": 7, "cmd": "inject_incident", "type": "accident", "edge": "A0_B0"},
        {"v": 1, "id": 8, "cmd": "inject_incident", "type": "accident"},
        {"v": 1, "id": 9, "cmd": "clear_incidents"},
    ]  # fmt: skip
    for example in examples:
        CLIENT_COMMAND.validate_python(example)  # every example is valid backend input
    return examples


def replay_examples() -> tuple[ReplayIndexMsg, ReplayRunMsg]:
    """A tiny recorded run (what experiments/telemetry holds) and an index entry for it."""
    summary = {
        "origin": "w0_A0", "destination": "B1_e1", "dispatch_s": 310.0, "trip_m": 1051.8,
        "arrived": True, "valid": True, "signal_program": "tuned", "cycle_s": 34.7,
        "travel_s": 7.0, "wait_s": 0.0, "stops": 0, "red_stops": 0, "red_crossings": 0,
        "approach_clear_s": None, "queue_mean": 0.5, "bg_time_loss_s": 100200.0,
        "preemptions": 1, "route_changes": 0, "violations": 0, "collisions": 0,
        "emergency_brakings": 1, "teleports": 0, "ambulance_collisions": None,
    }  # fmt: skip
    run = ReplayRunMsg.model_validate(
        {
            "v": 1, "schema_version": 1, "id": "basic_static/grid4x4_x1.5_seed001",
            "scenario": "grid4x4", "scale": 1.5, "seed": 1, "arm": "basic_static",
            "strategy": "basic", "routing": "static", "dispatch_s": 310.0, "duration_s": 12.0,
            "arrived": True, "mission_time": 7.0, "ambulance_edges": ["w0_A0", "A0_B0"],
            "ambulance": [
                [0.0, 0.0, 204.8, 90.0, 0.0, 0, 0],
                [7.0, 100.5, 204.8, 90.0, 15.2, 1, 1],
            ],
            "status": [[0.0, 7.0, 90.0, "A0", "r"], [7.0, None, None, None, None]],
            "routes": [{"t": 0.0, "edges": ["w0_A0", "A0_B0"], "eta": 7.0, "routing": "static"}],
            "signals": {
                "ids": ["A0"], "initial": ["GGrr"], "initial_control": ["program"],
                "changes": [[3.3, 0, "yyrr", "clearing"], [5.3, 0, "GGrr", "preempted"]],
            },
            "events": [
                {"t": 0.0, "kind": "dispatch", "text": "ambulance dispatched"},
                {"t": 3.3, "kind": "preempt", "junction": "A0", "accepted": True,
                 "text": "ETA 14.7 s: clearing A0 for w0_A0 (yellow 4 s, all-red 2 s)"},
            ],
            "edges": {"ids": ["w0_A0"], "interval_s": 5.0,
                      "samples": [{"t": 0.0, "halting": [0], "vehicles": [2], "speed": [9.5]}]},
            "traffic": {"interval_s": 1.0, "ids": ["f_0.1"], "types": ["car_sedan"],
                        "samples": [[0.0, [0, 12.5, 204.8, 90.0]]]},
            "incidents": [], "summary": summary,
            "verification": {"matches_recorded": True, "checked": 17, "differences": []},
            "recorded_with": {"git_sha": "a" * 40, "git_dirty": False,
                              "sumo_version": "Eclipse SUMO 1.27.1",
                              "created_at": "2026-10-06T00:00:00+00:00"},
        }
    )  # fmt: skip
    index = ReplayIndexMsg.model_validate(
        {
            "available": True,
            "runs": [
                {
                    "id": run.id, "scenario": "grid4x4", "scale": 1.5, "seed": 1,
                    "arm": "basic_static", "strategy": "basic", "routing": "static",
                    "summary": summary, "telemetry": True, "matches_recorded": True,
                    "traffic": True, "differences": [],
                }
            ],
        }
    )  # fmt: skip
    return index, run


def server_examples() -> dict[str, tuple[str, Any]]:
    """name -> (TypeScript type, serialised message)."""
    driving = StateMsg(
        seq=1234,
        t=123.4,
        mode="BASIC",
        vehicles=[
            VehicleMsg(
                id="ambulance_01",
                type="ambulance",
                x=421.4,
                y=193.2,
                angle=90.0,
                speed=16.8,
                edge="A0_B0",
                lane=1,
            ),
            VehicleMsg(
                id="f_w0_e0.3",
                type="car_sedan",
                x=300.1,
                y=204.8,
                angle=90.0,
                speed=12.5,
                edge=":A0_13_0",
                lane=0,
            ),
        ],
        signals=[
            SignalMsg(
                id="B0", state="rrrrrrrrrrrrGGGG", phase=0, preempted=True, control="preempted"
            ),
            SignalMsg(id="A0", state="GGGgrrrrGGGgrrrr", phase=0),
        ],
        ambulance=AmbulanceMsg(
            status="driving",
            throttle=1.0,
            brake=0.0,
            next_signal=NextSignalMsg(junction="B0", link_index=13, distance=84.2, state="G"),
            planned_turn=PlannedTurnMsg(junction="B0", turn="left", edge="B0_B1"),
            queued_turn="right",
            mission_time=41.5,
        ),
        route=RouteMsg(
            edges=["A0_B0", "B0_B1", "B1_e1"],
            turns=[
                RouteTurnMsg(junction="B0", turn="left", edge="B0_B1"),
                RouteTurnMsg(junction="B1", turn="right", edge="B1_e1"),
            ],
            eta=31.4,
            distance=512.0,
            follows=True,
            routing="dynamic",
            computed_at=123.0,
            drive=27.9,
            queue=3.5,
            signal=0.0,
            compromised=True,
            compromised_by="A1_B1",
            eta_change=6.2,
            blocked_ahead=False,
        ),
        metrics=MetricsMsg(eta=31.4, signals_preempted=2, queue_cleared=1, time_saved=12.3),
        safety=SafetyMsg(
            violations=0,
            collisions=0,
            events=[
                SafetyEventMsg(
                    t=18.4,
                    junction="B0",
                    vehicle="ambulance_01",
                    action="preempt",
                    accepted=True,
                    reason="ETA 14.5 s: clearing B0 for A0_B0",
                ),
                SafetyEventMsg(
                    t=19.0,
                    junction="B1",
                    vehicle=None,
                    action="preempt",
                    accepted=False,
                    reason="unknown junction B1",
                ),
            ],
        ),
        incidents=[
            IncidentMsg(
                id="incident_1",
                type="accident",
                edge="A1_B1",
                lane=0,
                x=332.5,
                y=454.8,
                angle=90.0,
                since=120.0,
            ),
        ],
        ghost=GhostMsg(
            phase="arrived",
            pose=GhostPoseMsg(t=123.3, x=598.1, y=454.8, angle=90.0, speed=0.0, edge="B1_e1"),
            mission_time=53.8,
        ),
    )
    idle = StateMsg(
        seq=1,
        t=0.1,
        mode="OFF",
        vehicles=[],
        signals=[SignalMsg(id="A0", state="GGGgrrrrGGGgrrrr", phase=0)],
        ambulance=AmbulanceMsg(status="none"),
        safety=SafetyMsg(violations=0, collisions=0, events=[]),
    )
    payload = RoadNetwork("grid2x2").payload()
    payload["lanes"] = payload["lanes"][:2]
    payload["junctions"] = payload["junctions"][:1]
    payload["signals"] = [{"id": payload["signals"][0]["id"],
                           "links": payload["signals"][0]["links"][:2]}]  # fmt: skip
    network = NetworkMsg.model_validate(payload)
    health = HealthMsg(status="running", seq=10, t=1.0, vehicles=5, tick_ms_p50=2.1,
                       tick_ms_p95=4.0, tick_ms_max=6.3, sumo_step_ms_p50=1.9)  # fmt: skip
    idle_health = HealthMsg(status="starting")
    safe = ResultSafetyMsg(violations=0, collisions=0, emergency_brakings=1, teleports=0)
    results = ResultsMsg(
        available=True,
        generated_at="2026-10-05T18:00:00+00:00",
        note="Autopilot batch runs (the live demo is driven manually). Rule-based, simulated.",
        baseline="off_strict_static",
        experiments=[
            ResultExperimentMsg(
                scenario="grid4x4", scale=1.5, seeds=[1, 2, 3], pairing_ok=True,
                signal_program="tuned", cycle_s=35.2,
                arms=[
                    ResultArmMsg(
                        arm="off_strict_static", label="OFF strict · static",
                        signals="off_strict", routing="static", runs=3, valid=3,
                        travel_mean=180.4, travel_ci=(160.2, 201.0), wait_mean=41.0,
                        safety=safe, travel_vs_baseline=None, bg_delay_vs_baseline=None,
                    ),
                    ResultArmMsg(
                        arm="coord_dynamic", label="COORD · dynamic", signals="coord",
                        routing="dynamic", runs=3, valid=3, travel_mean=120.1,
                        travel_ci=(110.0, 130.5), wait_mean=0.4, safety=safe,
                        travel_vs_baseline=PairedMsg(n=3, mean_diff=-60.3,
                                                     ci=(-80.1, -41.2), p=0.25),
                        bg_delay_vs_baseline=PairedMsg(n=3, mean_diff=812.0,
                                                       ci=(300.5, 1300.0), p=0.25),
                    ),
                ],
            )
        ],
    )  # fmt: skip
    no_results = ResultsMsg(available=False, note="no experiment results yet")
    replay_index, replay_run = replay_examples()
    return {
        "stateDriving": ("StateMsg", driving.model_dump(mode="json")),
        "stateIdle": ("StateMsg", idle.model_dump(mode="json")),
        "ackRejected": ("AckMsg", AckMsg(id=3, ok=False, reason="no lane further left")
                        .model_dump(mode="json")),
        "ackAccepted": ("AckMsg", AckMsg(id=4, ok=True).model_dump(mode="json")),
        "error": ("ErrorMsg", ErrorMsg(reason="message is not valid JSON").model_dump(mode="json")),
        "sessionDriver": ("SessionMsg", SessionMsg(client_id="tab-0123456789", role="driver")
                          .model_dump(mode="json")),
        "network": ("NetworkMsg", network.model_dump(mode="json")),
        "health": ("HealthMsg", health.model_dump(mode="json")),
        "healthStarting": ("HealthMsg", idle_health.model_dump(mode="json")),
        "results": ("ResultsMsg", results.model_dump(mode="json")),
        "noResults": ("ResultsMsg", no_results.model_dump(mode="json")),
        "replayIndex": ("ReplayIndexMsg", replay_index.model_dump(mode="json")),
        "replayRun": ("ReplayRunMsg", replay_run.model_dump(mode="json")),
    }  # fmt: skip


def render() -> str:
    lines = [
        "// GENERATED by backend/scripts/gen_contract.py from backend/api/protocol.py.",
        "// Do not edit. Regenerate from backend/:",
        "//   .venv\\Scripts\\python.exe -m scripts.gen_contract",
        "// Each fixture `satisfies` the hand-written type in state.ts: drift fails to compile.",
        "import type {",
        "  AckMsg,",
        "  Command,",
        "  ErrorMsg,",
        "  HealthMsg,",
        "  NetworkMsg,",
        "  ReplayIndexMsg,",
        "  ReplayRunMsg,",
        "  ResultsMsg,",
        "  SessionMsg,",
        "  StateMsg,",
        '} from "./state";',
        "",
    ]
    for name, (ts_type, value) in server_examples().items():
        lines.append(f"export const {name} = {json.dumps(value, indent=2)} satisfies {ts_type};")
        lines.append("")
    lines.append(
        f"export const commands = {json.dumps(command_examples(), indent=2)} satisfies Command[];"
    )
    lines.append("")
    lines.append(f"export const BACKEND_COMMANDS = {json.dumps(command_names())} as const;")
    lines.append(f"export const BACKEND_SERVER_TYPES = {json.dumps(list(SERVER_TYPES))} as const;")
    enums = {name: literal_values(model, field) for name, (model, field) in ENUMS.items()}
    lines.append(f"export const BACKEND_ENUMS = {json.dumps(enums, indent=2)} as const;")
    return "\n".join(lines) + "\n"


def network_fixtures() -> dict[Path, str]:
    """Full GET /api/network payloads of the shipped scenarios, for the city layout tests."""
    fixtures = {}
    for scenario in NETWORK_SCENARIOS:
        payload = NetworkMsg.model_validate(RoadNetwork(scenario).payload()).model_dump(mode="json")
        fixtures[NETWORK_DIR / f"network.{scenario}.json"] = json.dumps(payload) + "\n"
    return fixtures


def main() -> int:
    OUTPUT.write_text(render(), encoding="utf-8", newline="\n")
    print(f"wrote {OUTPUT.relative_to(REPO_ROOT)}")
    NETWORK_DIR.mkdir(exist_ok=True)
    for path, text in network_fixtures().items():
        path.write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {path.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

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
    HealthMsg,
    MetricsMsg,
    NetworkMsg,
    NextSignalMsg,
    PlannedTurnMsg,
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
    ]  # fmt: skip
    for example in examples:
        CLIENT_COMMAND.validate_python(example)  # every example is valid backend input
    return examples


def server_examples() -> dict[str, tuple[str, Any]]:
    """name -> (TypeScript type, serialised message)."""
    driving = StateMsg(
        seq=1234,
        t=123.4,
        mode="BASIC",
        vehicles=[
            VehicleMsg(id="ambulance_01", type="ambulance", x=421.4, y=193.2, angle=90.0,
                       speed=16.8, edge="A0_B0", lane=1),
            VehicleMsg(id="f_w0_e0.3", type="car_sedan", x=300.1, y=204.8, angle=90.0,
                       speed=12.5, edge=":A0_13_0", lane=0),
        ],  # fmt: skip
        signals=[
            SignalMsg(id="B0", state="rrrrrrrrrrrrGGGG", phase=0, preempted=True,
                      control="preempted"),
            SignalMsg(id="A0", state="GGGgrrrrGGGgrrrr", phase=0),
        ],  # fmt: skip
        ambulance=AmbulanceMsg(
            status="driving",
            throttle=1.0,
            brake=0.0,
            next_signal=NextSignalMsg(junction="B0", link_index=13, distance=84.2, state="G"),
            planned_turn=PlannedTurnMsg(junction="B0", turn="left", edge="B0_B1"),
            queued_turn="right",
            mission_time=41.5,
        ),
        metrics=MetricsMsg(signals_preempted=2),
        safety=SafetyMsg(
            violations=0,
            collisions=0,
            events=[
                SafetyEventMsg(t=18.4, junction="B0", vehicle="ambulance_01", action="preempt",
                               accepted=True, reason="ETA 14.5 s: clearing B0 for A0_B0"),
                SafetyEventMsg(t=19.0, junction="B1", vehicle=None, action="preempt",
                               accepted=False, reason="unknown junction B1"),
            ],
        ),  # fmt: skip
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

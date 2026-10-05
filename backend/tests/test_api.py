"""Sprint 2: HTTP + WebSocket protocol v1 against a live engine (10 Hz)."""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketTestSession

from main import create_app
from simulation.engine import SimulationEngine
from simulation.sumo import SumoConfig

Msg = dict[str, Any]


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    engine = SimulationEngine(SumoConfig(log_path=tmp_path / "sumo.log"))
    with TestClient(create_app(engine)) as test_client:
        yield test_client


def wait_for(ws: WebSocketTestSession, match: Callable[[Msg], bool], limit: int = 200) -> Msg:
    for _ in range(limit):
        msg: Msg = ws.receive_json()
        if match(msg):
            return msg
    pytest.fail("expected message never arrived")


def ack(command_id: int) -> Callable[[Msg], bool]:
    return lambda m: m["type"] == "ack" and m["id"] == command_id


def test_network_has_geometry_signals_depot_and_hospital(client: TestClient) -> None:
    data = client.get("/api/network").json()
    assert data["v"] == 1 and data["lefthand"] is True
    assert len(data["lanes"]) == 48  # 24 one-way edges x 2 lanes
    assert {s["id"] for s in data["signals"]} == {"A0", "A1", "B0", "B1"}
    link = data["signals"][0]["links"][12]
    assert link == {
        "index": 12,
        "fromLane": "w0_A0_0",
        "toLane": "A0_A1_0",
        "dir": "l",
        "approach": "w0_A0",
    }
    assert data["depot"]["edge"] == "w0_A0" and data["hospital"]["edge"] == "B1_e1"


def test_health_reports_running(client: TestClient) -> None:
    deadline = time.monotonic() + 10
    while client.get("/api/health").json()["status"] != "running":
        assert time.monotonic() < deadline
        time.sleep(0.1)


def test_state_ticks_arrive_at_10_hz(client: TestClient) -> None:
    with client.websocket_connect("/ws") as ws:
        first = wait_for(ws, lambda m: m["type"] == "state")  # after the session message
        start = time.monotonic()
        ticks = [ws.receive_json() for _ in range(20)]
        elapsed = time.monotonic() - start
    assert first["v"] == 1 and first["type"] == "state" and first["mode"] == "OFF"
    assert 1.5 <= elapsed <= 2.6, f"20 ticks took {elapsed:.2f} s"
    seqs = [t["seq"] for t in [first, *ticks]]
    assert seqs == sorted(seqs)
    tick = ticks[-1]
    assert tick["ambulance"]["status"] == "none"
    assert {"metrics", "route", "incidents", "signals", "vehicles"} <= tick.keys()
    assert tick["metrics"]["timeSaved"] is None
    assert len(tick["signals"][0]["state"]) == 16
    assert tick["signals"][0]["control"] == "program" and tick["signals"][0]["preempted"] is False
    assert tick["safety"] == {"violations": 0, "collisions": 0, "events": []}


FULL_THROTTLE = {
    "v": 1,
    "cmd": "drive",
    "vehicle": "ambulance_01",
    "control": {"throttle": 1, "brake": 0},
}


def drive_until(ws: WebSocketTestSession, match: Callable[[Msg], bool], limit: int) -> Msg:
    """Hold W like the browser does: a drive message per tick keeps the 0.5 s deadman alive."""
    for _ in range(limit):
        ws.send_json(FULL_THROTTLE)
        msg: Msg = ws.receive_json()
        if match(msg):
            return msg
    pytest.fail("expected message never arrived")


def test_basic_mode_preempts_over_the_websocket(client: TestClient) -> None:
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"v": 1, "id": 1, "cmd": "set_mode", "mode": "BASIC"})
        assert wait_for(ws, ack(1)) == {
            "v": 1,
            "type": "ack",
            "id": 1,
            "ok": True,
            "reason": "BASIC mode",
        }
        ws.send_json({"v": 1, "id": 2, "cmd": "set_mode", "mode": "COORD"})  # since Sprint 7
        assert wait_for(ws, ack(2))["reason"] == "COORD mode"
        ws.send_json({"v": 1, "id": 9, "cmd": "set_mode", "mode": "BASIC"})
        assert wait_for(ws, ack(9))["ok"] is True
        ws.send_json({"v": 1, "id": 3, "cmd": "spawn_ambulance"})
        wait_for(ws, ack(3))
        preempting = drive_until(
            ws, lambda m: m["type"] == "state" and m["signals"][0]["control"] != "program", 200
        )
        a0 = preempting["signals"][0]
        assert a0["id"] == "A0" and a0["preempted"] is True and preempting["mode"] == "BASIC"
        event = preempting["safety"]["events"][-1]
        assert event["junction"] == "A0" and event["accepted"] and event["reason"]
        assert preempting["ambulance"]["nextSignal"]["linkIndex"] in (12, 13, 14, 15)
        green = drive_until(
            ws, lambda m: m["type"] == "state" and m["metrics"]["signalsPreempted"] == 1, 150
        )
        assert green["safety"]["violations"] == 0


def test_live_server_uses_24_hour_traffic() -> None:
    from main import LIVE_ROUTES, engine_from_env

    assert engine_from_env().config.routes == LIVE_ROUTES == "routes.live.rou.xml"


def test_drive_session_acks_and_rejections(client: TestClient) -> None:
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"v": 1, "id": 1, "cmd": "spawn_ambulance"})
        assert wait_for(ws, ack(1))["ok"] is True
        state = wait_for(
            ws, lambda m: m["type"] == "state" and m["ambulance"]["status"] == "driving"
        )
        ambulance = next(v for v in state["vehicles"] if v["id"] == "ambulance_01")
        assert ambulance["type"] == "ambulance" and ambulance["edge"] == "w0_A0"

        ws.send_json(
            {
                "v": 1,
                "cmd": "drive",
                "vehicle": "ambulance_01",
                "control": {"throttle": 1, "brake": 0},
            }
        )
        moving = wait_for(ws, lambda m: m["type"] == "state" and m["ambulance"]["throttle"] == 1)
        assert moving["ambulance"]["plannedTurn"]["turn"] == "straight"

        ws.send_json(
            {"v": 1, "id": 2, "cmd": "turn", "vehicle": "ambulance_01", "direction": "left"}
        )
        assert wait_for(ws, ack(2))["ok"] is True
        planned = wait_for(
            ws, lambda m: m["type"] == "state" and m["ambulance"]["plannedTurn"]["turn"] == "left"
        )
        assert planned["ambulance"]["plannedTurn"]["edge"] == "A0_A1"

        ws.send_json(
            {"v": 1, "id": 3, "cmd": "lane", "vehicle": "ambulance_01", "direction": "left"}
        )
        rejected = wait_for(ws, ack(3))
        assert rejected["ok"] is False and rejected["reason"] == "no lane further left"

        ws.send_json({"v": 1, "id": 4, "cmd": "turn", "vehicle": "bus_9", "direction": "left"})
        assert wait_for(ws, ack(4))["reason"] == "unknown vehicle 'bus_9'"

        ws.send_json({"v": 2, "id": 5, "cmd": "reset"})
        bad_version = wait_for(ws, ack(5))
        assert bad_version["ok"] is False and bad_version["reason"].startswith("invalid command")

        ws.send_text("not json")
        assert wait_for(ws, lambda m: m["type"] == "error")["reason"] == "message is not valid JSON"

        ws.send_json({"v": 1, "id": 6, "cmd": "reset"})
        assert wait_for(ws, ack(6))["ok"] is True
        after = wait_for(ws, lambda m: m["type"] == "state" and m["t"] < 1.0)
        assert after["ambulance"]["status"] == "none"

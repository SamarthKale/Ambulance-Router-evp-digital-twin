"""Sprint 4: driver lock (one screen drives, others observe) and reconnects."""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketTestSession

from api.websocket import OBSERVER_REASON
from main import create_app
from simulation.engine import SimulationEngine
from simulation.sumo import SumoConfig

Msg = dict[str, Any]
AMB = "ambulance_01"


@contextmanager
def app_client(tmp_path: Path, grace_s: float = 10.0) -> Iterator[TestClient]:
    engine = SimulationEngine(SumoConfig(log_path=tmp_path / "sumo.log"))
    with TestClient(create_app(engine, driver_grace_s=grace_s)) as client:
        yield client


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with app_client(tmp_path) as c:
        yield c


def wait_for(ws: WebSocketTestSession, match: Callable[[Msg], bool], limit: int = 100) -> Msg:
    for _ in range(limit):
        msg: Msg = ws.receive_json()
        if match(msg):
            return msg
    pytest.fail("expected message never arrived")


def expect(
    ws: WebSocketTestSession, *matchers: Callable[[Msg], bool], limit: int = 100
) -> list[Msg]:
    """Wait until every matcher has matched a message, in any order."""
    found: list[Msg | None] = [None] * len(matchers)
    for _ in range(limit):
        msg: Msg = ws.receive_json()
        for i, match in enumerate(matchers):
            if found[i] is None and match(msg):
                found[i] = msg
        if all(f is not None for f in found):
            return [f for f in found if f is not None]
    pytest.fail("expected messages never arrived")


def session(role: str) -> Callable[[Msg], bool]:
    return lambda m: m["type"] == "session" and m["role"] == role


def ack(command_id: int) -> Callable[[Msg], bool]:
    return lambda m: m["type"] == "ack" and m["id"] == command_id


def hello(ws: WebSocketTestSession, client_id: str) -> Msg:
    ws.send_json({"v": 1, "cmd": "hello", "clientId": client_id})
    return wait_for(ws, lambda m: m["type"] == "session" and m["clientId"] == client_id)


def test_first_dispatcher_drives_and_others_observe(client: TestClient) -> None:
    with client.websocket_connect("/ws") as one, client.websocket_connect("/ws") as two:
        assert hello(one, "tab-one-0001")["role"] == "free"
        assert hello(two, "tab-two-0002")["role"] == "free"

        one.send_json({"v": 1, "id": 1, "cmd": "spawn_ambulance"})
        spawned, role = expect(one, ack(1), session("driver"))
        assert spawned["ok"] is True and role["clientId"] == "tab-one-0001"
        wait_for(two, session("observer"))

        for i, cmd in enumerate(
            [
                {"cmd": "spawn_ambulance"},
                {"cmd": "turn", "vehicle": AMB, "direction": "left"},
                {"cmd": "lane", "vehicle": AMB, "direction": "right"},
                {"cmd": "set_mode", "mode": "BASIC"},
                {"cmd": "reset"},
            ],
            start=10,
        ):
            two.send_json({"v": 1, "id": i, **cmd})
            rejected = wait_for(two, ack(i))
            assert rejected["ok"] is False and rejected["reason"] == OBSERVER_REASON, cmd

        # an observer's drive heartbeats never reach the ambulance
        for _ in range(10):
            two.send_json({"v": 1, "cmd": "drive", "vehicle": AMB,
                           "control": {"throttle": 1, "brake": 0}})  # fmt: skip
            state = wait_for(one, lambda m: m["type"] == "state")
            assert state["ambulance"]["throttle"] == 0

        two.send_json({"v": 1, "id": 20, "cmd": "release_control"})
        assert wait_for(two, ack(20))["reason"] == "you are not driving"
        one.send_json({"v": 1, "id": 21, "cmd": "release_control"})
        assert expect(one, ack(21), session("free"))[0]["ok"] is True
        wait_for(two, session("free"))

        two.send_json({"v": 1, "id": 22, "cmd": "spawn_ambulance"})
        assert expect(two, ack(22), session("driver"))[0]["ok"] is True
        wait_for(one, session("observer"))


def test_reset_frees_the_lock(client: TestClient) -> None:
    with client.websocket_connect("/ws") as one, client.websocket_connect("/ws") as two:
        one.send_json({"v": 1, "id": 1, "cmd": "spawn_ambulance"})
        wait_for(one, ack(1))
        wait_for(two, session("observer"))
        one.send_json({"v": 1, "id": 2, "cmd": "reset"})
        assert wait_for(one, ack(2))["ok"] is True
        wait_for(two, session("free"))


def test_driver_keeps_control_when_reconnecting(client: TestClient) -> None:
    with client.websocket_connect("/ws") as one:
        hello(one, "tab-driver-01")
        one.send_json({"v": 1, "id": 1, "cmd": "spawn_ambulance"})
        expect(one, ack(1), session("driver"))
    # connection dropped; the same tab comes back within the grace period
    with client.websocket_connect("/ws") as again, client.websocket_connect("/ws") as other:
        first = again.receive_json()
        assert first["type"] in ("state", "session")  # the world is sent at once
        assert hello(again, "tab-driver-01")["role"] == "driver"
        assert hello(other, "tab-other-02")["role"] == "observer"
        again.send_json({"v": 1, "id": 2, "cmd": "turn", "vehicle": AMB, "direction": "left"})
        assert wait_for(again, ack(2))["ok"] is True


def test_lock_is_released_when_the_driver_does_not_return(tmp_path: Path) -> None:
    with app_client(tmp_path, grace_s=0.3) as client:
        with client.websocket_connect("/ws") as one:
            hello(one, "tab-gone-0001")
            one.send_json({"v": 1, "id": 1, "cmd": "spawn_ambulance"})
            wait_for(one, ack(1))
        time.sleep(0.8)
        with client.websocket_connect("/ws") as two:
            assert hello(two, "tab-new-00002")["role"] == "free"
            two.send_json({"v": 1, "id": 2, "cmd": "spawn_ambulance"})
            assert wait_for(two, ack(2))["ok"] is True


def test_hello_is_validated(client: TestClient) -> None:
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"v": 1, "cmd": "hello", "clientId": "x"})  # too short
        error = wait_for(ws, lambda m: m["type"] == "error")
        assert error["reason"].startswith("invalid command")

"""WebSocket endpoint: commands in; state ticks, acks and session messages out (protocol v1)."""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from api.channel import Broadcaster, ClientChannel
from api.protocol import (
    CLIENT_COMMAND,
    AckMsg,
    DriveCmd,
    ErrorMsg,
    HelloCmd,
    ReleaseControlCmd,
    ResetCmd,
    SpawnAmbulanceCmd,
    to_engine_command,
)
from api.session import SessionManager
from simulation.engine import SimulationEngine
from simulation.manual_control import CommandResult
from simulation.vehicle import AMBULANCE_ID

log = logging.getLogger(__name__)
router = APIRouter()

COMMAND_TIMEOUT_S = 2.0
# Reset restarts SUMO and fast-forwards the live warm-up (EF_WARMUP_S, 120 s simulated):
# ~10 s on the 4x4 grid at 1.5x plugged in, longer on battery.
RESET_TIMEOUT_S = 120.0
OBSERVER_REASON = "observer: another screen is driving"


@router.websocket("/ws")
async def state_socket(ws: WebSocket) -> None:
    engine: SimulationEngine = ws.app.state.engine
    broadcaster: Broadcaster = ws.app.state.broadcaster
    session: SessionManager = ws.app.state.session
    await ws.accept()
    channel = broadcaster.register()
    session.connect(channel)
    sender = asyncio.create_task(_send_loop(ws, channel))
    pending: set[asyncio.Task[None]] = set()
    try:
        while True:
            handle_message(engine, session, channel, await ws.receive_text(), pending)
    except WebSocketDisconnect:
        pass
    finally:
        broadcaster.unregister(channel)
        session.disconnect(channel)
        sender.cancel()
        for task in pending:
            task.cancel()


async def _send_loop(ws: WebSocket, channel: ClientChannel) -> None:
    try:
        while True:
            for text in await channel.next_batch():
                await ws.send_text(text)
    except (WebSocketDisconnect, RuntimeError):
        pass  # client went away; the receive loop cleans up


def _ack(channel: ClientChannel, command_id: int, ok: bool, reason: str) -> None:
    channel.push_ack(AckMsg(id=command_id, ok=ok, reason=reason).model_dump_json())


def handle_message(
    engine: SimulationEngine,
    session: SessionManager,
    channel: ClientChannel,
    text: str,
    pending: set[asyncio.Task[None]],
) -> None:
    """Validate, apply the driver lock, and submit in arrival order. Acks are sent once the
    engine has run the command."""
    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        channel.push_ack(ErrorMsg(reason="message is not valid JSON").model_dump_json())
        return
    raw_id = raw.get("id") if isinstance(raw, dict) else None
    command_id = raw_id if isinstance(raw_id, int) else None
    try:
        cmd = CLIENT_COMMAND.validate_python(raw)
    except ValidationError as exc:
        error = exc.errors()[0]
        where = ".".join(str(part) for part in error["loc"])
        reason = f"invalid command: {where}: {error['msg']}"
        reply = (
            AckMsg(id=command_id, ok=False, reason=reason)
            if command_id is not None
            else ErrorMsg(reason=reason)
        )
        channel.push_ack(reply.model_dump_json())
        return

    me = session.client_id(channel)
    if isinstance(cmd, HelloCmd):
        session.hello(channel, cmd.client_id)  # replies with a session message
        return
    if isinstance(cmd, ReleaseControlCmd):
        if session.driver == me:
            session.release("released by the driver")
            _ack(channel, cmd.id, True, "control released")
        else:
            _ack(channel, cmd.id, False, "you are not driving")
        return

    vehicle = getattr(cmd, "vehicle", AMBULANCE_ID)
    if not session.may_control(me):
        if not isinstance(cmd, DriveCmd):  # observers' drive heartbeats are dropped silently
            _ack(channel, cmd.id, False, OBSERVER_REASON)
        return
    if vehicle != AMBULANCE_ID:
        if not isinstance(cmd, DriveCmd):
            _ack(channel, cmd.id, False, f"unknown vehicle '{vehicle}'")
        return
    if isinstance(cmd, SpawnAmbulanceCmd):
        session.claim(me)  # the first client to dispatch drives
    elif isinstance(cmd, ResetCmd):
        session.release("simulation reset")
    future = engine.submit(to_engine_command(cmd))  # submitted now, so order is preserved
    if isinstance(cmd, DriveCmd):
        return  # fire and forget, no ack
    command = cmd
    timeout = RESET_TIMEOUT_S if isinstance(cmd, ResetCmd) else COMMAND_TIMEOUT_S

    async def ack_when_done() -> None:
        try:
            result = await asyncio.wait_for(asyncio.wrap_future(future), timeout)
        except TimeoutError:
            result = CommandResult(False, "simulation not responding")
        _ack(channel, command.id, result.ok, result.reason)

    task = asyncio.create_task(ack_when_done())
    pending.add(task)
    task.add_done_callback(pending.discard)

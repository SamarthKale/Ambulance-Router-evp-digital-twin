"""WebSocket endpoint: commands in; state ticks and acks out (protocol v1)."""

from __future__ import annotations

import asyncio
import json
import logging
from collections import deque

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from api.protocol import (
    CLIENT_COMMAND,
    AckMsg,
    DriveCmd,
    ErrorMsg,
    state_message,
    to_engine_command,
)
from simulation.engine import EngineState, SimulationEngine
from simulation.manual_control import CommandResult
from simulation.vehicle import AMBULANCE_ID

log = logging.getLogger(__name__)
router = APIRouter()

COMMAND_TIMEOUT_S = 2.0


class ClientChannel:
    """Outgoing messages for one client. Every ack is delivered, but only the newest
    state tick: a slow client skips ticks instead of falling further behind."""

    def __init__(self) -> None:
        self._acks: deque[str] = deque()
        self._tick: str | None = None
        self._wakeup = asyncio.Event()

    def push_ack(self, text: str) -> None:
        self._acks.append(text)
        self._wakeup.set()

    def push_tick(self, text: str) -> None:
        self._tick = text
        self._wakeup.set()

    async def next_batch(self) -> list[str]:
        await self._wakeup.wait()
        self._wakeup.clear()
        batch = list(self._acks)
        self._acks.clear()
        if self._tick is not None:
            batch.append(self._tick)
            self._tick = None
        return batch


class Broadcaster:
    """Fans engine states out to clients. publish() runs on the event loop thread."""

    def __init__(self) -> None:
        self._clients: set[ClientChannel] = set()

    def register(self) -> ClientChannel:
        channel = ClientChannel()
        self._clients.add(channel)
        return channel

    def unregister(self, channel: ClientChannel) -> None:
        self._clients.discard(channel)

    def publish(self, state: EngineState) -> None:
        if not self._clients:
            return
        text = state_message(state).model_dump_json()  # serialised once for all clients
        for channel in self._clients:
            channel.push_tick(text)


@router.websocket("/ws")
async def state_socket(ws: WebSocket) -> None:
    engine: SimulationEngine = ws.app.state.engine
    broadcaster: Broadcaster = ws.app.state.broadcaster
    await ws.accept()
    channel = broadcaster.register()
    sender = asyncio.create_task(_send_loop(ws, channel))
    pending: set[asyncio.Task[None]] = set()
    try:
        while True:
            handle_message(engine, channel, await ws.receive_text(), pending)
    except WebSocketDisconnect:
        pass
    finally:
        broadcaster.unregister(channel)
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


def handle_message(
    engine: SimulationEngine, channel: ClientChannel, text: str, pending: set[asyncio.Task[None]]
) -> None:
    """Validate and submit in arrival order; acks are sent when the engine has run them."""
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

    vehicle = getattr(cmd, "vehicle", AMBULANCE_ID)
    if isinstance(cmd, DriveCmd):
        if vehicle == AMBULANCE_ID:
            engine.submit(to_engine_command(cmd))  # fire and forget, no ack
        return
    if vehicle != AMBULANCE_ID:
        reason = f"unknown vehicle '{vehicle}'"
        channel.push_ack(AckMsg(id=cmd.id, ok=False, reason=reason).model_dump_json())
        return
    future = engine.submit(to_engine_command(cmd))  # submitted now, so order is preserved

    async def ack_when_done() -> None:
        try:
            result = await asyncio.wait_for(asyncio.wrap_future(future), COMMAND_TIMEOUT_S)
        except TimeoutError:
            result = CommandResult(False, "simulation not responding")
        reply = AckMsg(id=cmd.id, ok=result.ok, reason=result.reason)
        channel.push_ack(reply.model_dump_json())

    task = asyncio.create_task(ack_when_done())
    pending.add(task)
    task.add_done_callback(pending.discard)

"""Outgoing message plumbing: one channel per client, one broadcaster for state ticks."""

from __future__ import annotations

import asyncio
from collections import deque

from api.protocol import state_message
from simulation.engine import EngineState


class ClientChannel:
    """Outgoing messages for one client. Every ack/session message is delivered, but only
    the newest state tick: a slow client skips ticks instead of falling further behind."""

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
    """Fans engine states out to clients. Runs on the event loop thread."""

    def __init__(self) -> None:
        self._clients: set[ClientChannel] = set()
        self._latest: EngineState | None = None

    def register(self) -> ClientChannel:
        channel = ClientChannel()
        self._clients.add(channel)
        if self._latest is not None:  # a (re)connecting client sees the world at once
            channel.push_tick(state_message(self._latest).model_dump_json())
        return channel

    def unregister(self, channel: ClientChannel) -> None:
        self._clients.discard(channel)

    def publish(self, state: EngineState) -> None:
        self._latest = state
        if not self._clients:
            return
        text = state_message(state).model_dump_json()  # serialised once for all clients
        for channel in self._clients:
            channel.push_tick(text)

"""Client sessions and the driver lock (one screen drives, the others watch).

The first client to dispatch the ambulance becomes the driver. Other clients are
observers: they receive every state tick but cannot drive, turn, change lanes, switch
modes or reset. The driver can release control; a reset releases it too.

A browser identifies itself with a client id (kept per tab) in a `hello` message. When the
driver's connection drops, control is held for a grace period so a reconnecting tab with
the same id gets it back. Runs on the event loop thread only.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Literal

from api.channel import ClientChannel
from api.protocol import SessionMsg

log = logging.getLogger(__name__)

DRIVER_GRACE_S = 10.0

Role = Literal["driver", "observer", "free"]


class SessionManager:
    def __init__(self, grace_s: float = DRIVER_GRACE_S) -> None:
        self.grace_s = grace_s
        self.driver: str | None = None
        self._clients: dict[ClientChannel, str] = {}
        self._release_timer: asyncio.TimerHandle | None = None

    # ---- connections -----------------------------------------------------------
    def connect(self, channel: ClientChannel) -> str:
        client_id = f"anon-{uuid.uuid4().hex[:12]}"
        self._clients[channel] = client_id
        self._send(channel)
        return client_id

    def hello(self, channel: ClientChannel, client_id: str) -> None:
        self._clients[channel] = client_id
        if client_id == self.driver and self._release_timer is not None:
            self._release_timer.cancel()  # the driver came back in time
            self._release_timer = None
            log.info("driver %s reconnected", client_id)
        self._send(channel)

    def disconnect(self, channel: ClientChannel) -> None:
        client_id = self._clients.pop(channel, None)
        if client_id is None or client_id != self.driver:
            return
        if client_id in self._clients.values():
            return  # still connected through another socket
        self._release_timer = asyncio.get_running_loop().call_later(
            self.grace_s, self._expire, client_id
        )

    def client_id(self, channel: ClientChannel) -> str:
        return self._clients[channel]

    # ---- driver lock -------------------------------------------------------------
    def role(self, client_id: str) -> Role:
        if self.driver is None:
            return "free"
        return "driver" if client_id == self.driver else "observer"

    def may_control(self, client_id: str) -> bool:
        return self.driver is None or self.driver == client_id

    def claim(self, client_id: str) -> None:
        if self.driver != client_id:
            self.driver = client_id
            log.info("%s is now driving", client_id)
            self._broadcast()

    def release(self, reason: str) -> None:
        if self._release_timer is not None:
            self._release_timer.cancel()
            self._release_timer = None
        if self.driver is not None:
            log.info("driver %s released (%s)", self.driver, reason)
            self.driver = None
            self._broadcast()

    def _expire(self, client_id: str) -> None:
        self._release_timer = None
        if self.driver == client_id:
            self.release(f"no reconnect within {self.grace_s:g} s")

    # ---- messages ------------------------------------------------------------------
    def _send(self, channel: ClientChannel) -> None:
        client_id = self._clients[channel]
        msg = SessionMsg(client_id=client_id, role=self.role(client_id))
        channel.push_ack(msg.model_dump_json())

    def _broadcast(self) -> None:
        for channel in list(self._clients):
            self._send(channel)

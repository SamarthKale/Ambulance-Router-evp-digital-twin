"""Experiment arms: signals {OFF strict, OFF realistic, BASIC, COORD} x routing
{static, dynamic}."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, get_args

Signals = Literal["off_strict", "off_realistic", "basic", "coord"]
RoutingArm = Literal["static", "dynamic"]
SIGNALS: tuple[Signals, ...] = get_args(Signals)
ROUTINGS: tuple[RoutingArm, ...] = get_args(RoutingArm)


@dataclass(frozen=True)
class Arm:
    signals: Signals
    routing: RoutingArm

    @property
    def id(self) -> str:
        return f"{self.signals}_{self.routing}"

    @property
    def mode(self) -> Literal["OFF", "BASIC", "COORD"]:
        if self.signals in ("off_strict", "off_realistic"):
            return "OFF"
        return "BASIC" if self.signals == "basic" else "COORD"

    @property
    def crosses_red(self) -> bool:
        """off_realistic: normal signals, but the ambulance crosses reds slowly (SUMO's
        junction model), as a real one with lights and siren may."""
        return self.signals == "off_realistic"


ALL_ARMS: tuple[Arm, ...] = tuple(Arm(s, r) for s in SIGNALS for r in ROUTINGS)
BASELINE = Arm("off_strict", "static")  # no priority, the route a map would give


def parse_arms(text: str) -> tuple[Arm, ...]:
    """'all', or comma-separated arm ids such as 'off_strict_static,basic_dynamic'."""
    if text.strip() == "all":
        return ALL_ARMS
    by_id = {arm.id: arm for arm in ALL_ARMS}
    arms = []
    for part in text.split(","):
        part = part.strip()
        if part not in by_id:
            raise ValueError(f"unknown arm '{part}'; choose from {', '.join(by_id)}")
        arms.append(by_id[part])
    return tuple(arms)

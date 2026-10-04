"""Traffic-light actuation: the ONLY module that changes signals in SUMO (CLAUDE.md section 2.3).

It executes actuations produced by the safety controller and nothing else. A guard test
(tests/test_architecture.py) fails if a signal-setting TraCI call appears anywhere else.
Also loads each junction's SignalTable (conflicts, approaches, normal program) from net.xml.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from collections.abc import Iterable
from pathlib import Path

from traci.connection import Connection

from safety.controller import Actuation, ResumeProgram, SetSignalState
from safety.signal_table import SignalTable


class TrafficLights:
    def __init__(self, conn: Connection) -> None:
        self._conn = conn

    def apply(self, actuations: Iterable[Actuation]) -> None:
        for actuation in actuations:
            match actuation:
                case SetSignalState(tls_id=tls_id, state=state):
                    self._conn.trafficlight.setRedYellowGreenState(tls_id, state)
                case ResumeProgram(tls_id=tls_id, program_id=program_id, phase=phase):
                    self._conn.trafficlight.setProgram(tls_id, program_id)
                    self._conn.trafficlight.setPhase(tls_id, phase)  # starts with its full duration


def load_signal_tables(net_path: Path) -> dict[str, SignalTable]:
    """Read conflicts (junction <request foes>), approaches and programs from net.xml.

    Signal link indices are mapped to the junction's request indices through the
    connection's internal lane (`via`), whose position in the junction's `intLanes` is its
    request index, so nothing assumes the two numberings coincide.
    """
    root = ET.parse(net_path).getroot()
    junctions = {j.get("id"): j for j in root.iter("junction")}
    links: dict[str, dict[int, tuple[str, str]]] = {}  # tls -> link index -> (via, from edge)
    next_internal: dict[str, str] = {}  # internal lane -> the internal lane it continues into
    for conn in root.iter("connection"):
        tls = conn.get("tl")
        source = conn.get("from", "")
        if tls is not None:
            links.setdefault(tls, {})[int(conn.get("linkIndex", "-1"))] = (
                conn.get("via", ""),
                source,
            )
        elif source.startswith(":") and conn.get("via"):
            next_internal[f"{source}_{conn.get('fromLane')}"] = conn.get("via", "")

    def request_index(int_lanes: list[str], via: str) -> int:
        # Turns that wait inside the junction are split in two internal lanes; the
        # junction lists the second part, so follow the chain until it is listed.
        lane = via
        for _ in range(4):
            if lane in int_lanes:
                return int_lanes.index(lane)
            lane = next_internal.get(lane, "")
        raise ValueError(f"internal lane {via} not found in the junction's intLanes")

    tables: dict[str, SignalTable] = {}
    for logic in root.iter("tlLogic"):
        tls = logic.get("id", "")
        junction = junctions[tls]
        int_lanes = junction.get("intLanes", "").split()
        request_foes = {
            int(r.get("index", "-1")): r.get("foes", "")[::-1]  # rightmost char = request 0
            for r in junction.iter("request")
        }
        tls_links = links[tls]
        count = len(tls_links)
        if sorted(tls_links) != list(range(count)):
            raise ValueError(f"{tls}: signal link indices are not 0..{count - 1}")
        request_of = {k: request_index(int_lanes, via) for k, (via, _) in tls_links.items()}
        link_of = {r: k for k, r in request_of.items()}
        foes = tuple(
            frozenset(
                link_of[r]
                for r, bit in enumerate(request_foes[request_of[k]])
                if bit == "1" and r in link_of
            )
            for k in range(count)
        )
        for k in range(count):
            for other in foes[k]:
                if k not in foes[other]:
                    raise ValueError(f"{tls}: conflict matrix is not symmetric ({k}, {other})")
        phases = tuple(
            (p.get("state", ""), float(p.get("duration", "0"))) for p in logic.iter("phase")
        )
        tables[tls] = SignalTable(
            tls_id=tls,
            foes=foes,
            approach_of=tuple(tls_links[k][1] for k in range(count)),
            program_id=logic.get("programID", "0"),
            phases=phases,
        )
    return tables

"""Sprint 1: the generated grid matches the agreed layout (CLAUDE.md section 6)."""

from __future__ import annotations

import xml.etree.ElementTree as ET

import pytest
import sumolib

from simulation.sumo import SumoConfig

NET_PATH = SumoConfig().sumocfg.parent / "network.net.xml"


@pytest.fixture(scope="module")
def net() -> sumolib.net.Net:
    return sumolib.net.readNet(str(NET_PATH))


def test_left_hand_traffic() -> None:
    assert ET.parse(NET_PATH).getroot().get("lefthand") == "true"


def test_four_signalized_junctions(net: sumolib.net.Net) -> None:
    assert sorted(t.getID() for t in net.getTrafficLights()) == ["A0", "A1", "B0", "B1"]


def test_two_lanes_each_way_at_50_kmh(net: sumolib.net.Net) -> None:
    for edge in net.getEdges():
        assert edge.getLaneNumber() == 2, edge.getID()
        assert edge.getSpeed() == pytest.approx(13.89), edge.getID()


def test_u_turns_only_at_map_edges(net: sumolib.net.Net) -> None:
    for edge in net.getEdges():
        node = edge.getToNode()
        u_turns = [e for e in edge.getOutgoing() if e.getToNode() == edge.getFromNode()]
        if node.getType() == "traffic_light":
            assert not u_turns, f"U-turn at signal {node.getID()} from {edge.getID()}"
        else:
            assert u_turns, f"no turnaround at map edge {node.getID()}"

"""Static road network of a scenario (sumolib, no TraCI): geometry for the frontend,
signal link tables, depot and hospital."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any

import sumolib
from sumolib.geomhelper import positionAtShapeOffset

from simulation.sumo import SCENARIOS_DIR


@dataclass(frozen=True)
class Place:
    edge: str
    pos: float  # m from the start of the edge
    x: float
    y: float


class RoadNetwork:
    def __init__(self, scenario: str) -> None:
        folder = SCENARIOS_DIR / scenario
        net_path = folder / "network.net.xml"
        self.scenario = scenario
        self.net = sumolib.net.readNet(str(net_path))
        self.lefthand = ET.parse(net_path).getroot().get("lefthand") == "true"
        places = json.loads((folder / "scenario.json").read_text())
        self.depot = self._place(places["depot"]["edge"], float(places["depot"]["pos"]))
        hospital_edge = places["hospital"]["edge"]
        hospital_pos = self.edge_length(hospital_edge) - float(places["hospital"]["stopBeforeEnd"])
        self.hospital = self._place(hospital_edge, hospital_pos)

    def edge_length(self, edge_id: str) -> float:
        return float(self.net.getEdge(edge_id).getLength())

    def _place(self, edge_id: str, pos: float) -> Place:
        shape = self.net.getEdge(edge_id).getLane(0).getShape()  # lane 0 = curb lane
        x, y = positionAtShapeOffset(shape, pos)
        return Place(edge=edge_id, pos=pos, x=float(x), y=float(y))

    def payload(self) -> dict[str, Any]:
        """Everything the frontend needs to draw the map (protocol v1, GET /api/network)."""
        xmin, ymin, xmax, ymax = self.net.getBoundary()
        lanes = [
            {
                "id": lane.getID(),
                "edge": edge.getID(),
                "index": lane.getIndex(),
                "width": lane.getWidth(),
                "shape": [[x, y] for x, y, *_ in lane.getShape()],
            }
            for edge in self.net.getEdges()
            for lane in edge.getLanes()
        ]
        junctions = [
            {
                "id": node.getID(),
                "type": node.getType(),
                "shape": [[x, y] for x, y, *_ in node.getShape()],
            }
            for node in self.net.getNodes()
        ]
        signals = [
            {"id": tls.getID(), "links": self._links(tls)}
            for tls in sorted(self.net.getTrafficLights(), key=lambda t: t.getID())
        ]
        return {
            "lefthand": self.lefthand,
            "bounds": [xmin, ymin, xmax, ymax],
            "lanes": lanes,
            "junctions": junctions,
            "signals": signals,
            "depot": self.depot.__dict__,
            "hospital": self.hospital.__dict__,
        }

    @staticmethod
    def _links(tls: sumolib.net.TLS) -> list[dict[str, Any]]:
        links = []
        for in_lane, out_lane, index in tls.getConnections():
            in_edge = in_lane.getEdge()
            direction = next(
                c.getDirection()
                for c in in_edge.getOutgoing()[out_lane.getEdge()]
                if c.getFromLane() == in_lane and c.getToLane() == out_lane
            )
            links.append(
                {
                    "index": index,
                    "fromLane": in_lane.getID(),
                    "toLane": out_lane.getID(),
                    "dir": direction,
                    "approach": in_edge.getID(),
                }
            )
        return sorted(links, key=lambda link: link["index"])

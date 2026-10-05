"""Seeded missions: per seed a random dispatch time after the warm-up and a random start and
destination on the map edge (CLAUDE.md section 14). Every arm runs the same mission."""

from __future__ import annotations

import random
from dataclasses import dataclass

from ai.routing import Conditions, RoadGraph, plan_route
from simulation.network import Mission, RoadNetwork

WARMUP_MIN_S = 300.0  # dispatch never earlier: traffic has filled the network
DISPATCH_SPREAD_S = 74.0  # one signal cycle, so the signals' phase at dispatch varies
MIN_TRIP_FRACTION = 0.75  # trips at least this share of the map's larger side


@dataclass(frozen=True)
class MissionSpec:
    seed: int
    origin: str  # entry road on the map edge
    destination: str  # exit road on another side of the map
    dispatch_s: float  # simulation time of the dispatch
    distance_m: float  # free-flow shortest route

    @property
    def mission(self) -> Mission:
        return Mission(self.origin, self.destination)


def _side(node_id: str) -> str:
    return node_id[0]  # map-edge nodes are n<col>, s<col>, w<row>, e<row> (build_grid.py)


def map_edge_roads(network: RoadNetwork, graph: RoadGraph) -> tuple[list[str], list[str]]:
    """Roads entering the grid from the map edge, and roads leaving it."""
    entries, exits = [], []
    for edge_id in sorted(graph.edges):
        edge = network.net.getEdge(edge_id)
        if edge.getFromNode().getType() != "traffic_light":
            entries.append(edge_id)
        if edge.getToNode().getType() != "traffic_light":
            exits.append(edge_id)
    return entries, exits


def draw_mission(network: RoadNetwork, graph: RoadGraph, seed: int) -> MissionSpec:
    rng = random.Random(seed)
    dispatch = round(WARMUP_MIN_S + rng.uniform(0.0, DISPATCH_SPREAD_S), 1)
    entries, exits = map_edge_roads(network, graph)
    xmin, ymin, xmax, ymax = network.net.getBoundary()
    min_trip = MIN_TRIP_FRACTION * max(xmax - xmin, ymax - ymin)
    for _ in range(1000):
        origin, destination = rng.choice(entries), rng.choice(exits)
        start = network.net.getEdge(origin).getFromNode().getID()
        end = network.net.getEdge(destination).getToNode().getID()
        if _side(start) == _side(end):
            continue
        target = network.with_mission(Mission(origin, destination)).hospital
        plan = plan_route(
            graph, origin, 0.0, destination, target.pos, Conditions(now=0.0, mode="BASIC")
        )
        if plan is not None and plan.distance_m >= min_trip:
            return MissionSpec(seed, origin, destination, dispatch, round(plan.distance_m, 1))
    raise RuntimeError(f"no mission of at least {min_trip:.0f} m found for seed {seed}")

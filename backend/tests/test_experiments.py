"""Sprint 9: seeded missions, one-run metrics and the experiment report (real SUMO, 2x2)."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path

import pandas as pd
import pytest

from evaluation.arms import ALL_ARMS, BASELINE, Arm, parse_arms
from evaluation.missions import DISPATCH_SPREAD_S, WARMUP_MIN_S, draw_mission, map_edge_roads
from evaluation.programs import PROGRAM_ID, tuned_program
from evaluation.report import save_manifest, save_runs, write_report
from evaluation.runner import RED_TYPE, RunSpec, run_one, write_red_vtype
from simulation.engine import SimulationEngine
from simulation.network import RoadNetwork
from simulation.sumo import SumoConfig
from simulation.traffic_lights import load_signal_tables
from tests.helpers import run


def test_arms_cover_signals_times_routing() -> None:
    assert len(ALL_ARMS) == 8 and BASELINE.id == "off_strict_static"
    assert [a.mode for a in parse_arms("off_realistic_dynamic,coord_static")] == ["OFF", "COORD"]
    assert Arm("off_realistic", "static").crosses_red and not Arm("basic", "static").crosses_red
    with pytest.raises(ValueError):
        parse_arms("turbo_dynamic")


@pytest.mark.parametrize("scenario", ["grid2x2", "grid4x4"])
def test_missions_are_seeded_and_cross_the_map(scenario: str) -> None:
    network = RoadNetwork(scenario)
    graph = network.road_graph()
    entries, exits = map_edge_roads(network, graph)
    xmin, _, xmax, _ = network.net.getBoundary()
    for seed in range(1, 21):
        mission = draw_mission(network, graph, seed)
        assert mission == draw_mission(network, graph, seed)  # same seed, same mission
        assert mission.origin in entries and mission.destination in exits
        assert WARMUP_MIN_S <= mission.dispatch_s <= WARMUP_MIN_S + DISPATCH_SPREAD_S
        start = network.net.getEdge(mission.origin).getFromNode().getID()
        end = network.net.getEdge(mission.destination).getToNode().getID()
        assert start[0] != end[0]  # different sides of the map
        assert mission.distance_m >= 0.75 * (xmax - xmin)
    assert len({draw_mission(network, graph, s) for s in range(1, 21)}) > 10


def test_red_crossing_vtype_copies_the_ambulance(tmp_path: Path) -> None:
    path = write_red_vtype("grid2x2", tmp_path / "red.add.xml")
    vtype = ET.parse(path).getroot().find("vType")
    assert vtype is not None and vtype.get("id") == RED_TYPE
    assert vtype.get("vClass") == "emergency" and vtype.get("sigma") == "0"
    assert float(vtype.get("jmDriveAfterRedTime", 0)) >= 74  # longer than any red
    assert float(vtype.get("jmDriveRedSpeed", 99)) <= 5.6  # crosses slowly


def test_arms_of_a_seed_start_from_the_same_traffic_and_report(tmp_path: Path) -> None:
    arms = [BASELINE, Arm("off_realistic", "dynamic"), Arm("basic", "dynamic")]
    results = [
        run_one(RunSpec("grid2x2", 1.0, 2, arm, window_s=150), tmp_path / arm.id) for arm in arms
    ]
    rows = [r["row"] for r in results]
    assert len({r["dispatch_hash"] for r in rows}) == 1  # paired: identical start
    assert len({r["dispatch_vehicles"] for r in rows}) == 1
    for row in rows:
        assert row["signal_program"] == "net" and row["cycle_s"] == 74.0
        assert row["arrived"] and row["valid"] and row["travel_s"] > 0
        assert row["violations"] == 0 and row["collisions"] == 0 and row["teleports"] == 0
        assert row["bg_vehicles"] > 0 and row["bg_time_loss_s"] > 0
    basic = rows[2]
    assert basic["preemptions"] > 0 and rows[0]["preemptions"] == 0
    assert basic["travel_s"] < rows[0]["travel_s"]
    manifest = results[0]["manifest"]
    assert manifest["sumo_version"].startswith("Eclipse SUMO") and len(manifest["git_sha"]) == 40
    assert manifest["seed"] == 2 and manifest["mission"]["origin"] == rows[0]["origin"]

    out = tmp_path / "experiments"
    save_runs(out, rows)
    for result in results:
        save_manifest(out, result["manifest"])
    save_runs(out, rows[:1])  # a re-run replaces its row instead of adding one
    assert len(pd.read_csv(out / BASELINE.id / "runs.csv")) == 1
    data = write_report(out)
    (experiment,) = data["experiments"]
    assert experiment["pairing_ok"] and experiment["seeds"] == [2]
    by_arm = {a["arm"]: a for a in experiment["arms"]}
    vs = by_arm["basic_dynamic"]["travel_s_vs_baseline"]
    assert vs["n"] == 1 and vs["mean_diff"] == pytest.approx(
        basic["travel_s"] - rows[0]["travel_s"], abs=0.01
    )
    paired = pd.read_csv(out / "summary" / "paired.csv")
    assert set(paired["reference"]) == {BASELINE.id}
    assert (out / "summary" / "travel_time_grid2x2_x1.png").stat().st_size > 10_000
    assert json.loads((out / "summary" / "summary.json").read_text())["baseline"] == BASELINE.id
    assert (out / "basic_dynamic" / "manifests" / "grid2x2_x1_seed002.json").exists()


def test_tuned_program_keeps_phases_and_clearances_and_passes_the_monitor(
    tmp_path: Path,
) -> None:
    out = tmp_path / "c--sparkathon26"  # '--' in a path once broke the tool's XML header
    path = tuned_program("grid2x2", 1.0, out)
    mtime = path.stat().st_mtime_ns
    assert tuned_program("grid2x2", 1.0, out) == path  # generated once, then reused
    ET.parse(path)  # well-formed XML
    assert "sparkathon26" not in path.read_text(encoding="utf-8")  # no local paths
    assert path.stat().st_mtime_ns == mtime
    config = SumoConfig(log_path=tmp_path / "sumo.log", signal_programs=path)
    net = load_signal_tables(config.net_path)
    tuned = load_signal_tables(config.net_path, path)
    for tls, table in tuned.items():
        assert table.program_id == PROGRAM_ID
        assert [s for s, _ in table.phases] == [s for s, _ in net[tls].phases]  # same states
        durations = [d for _, d in table.phases]
        assert durations[1::3] == [4.0, 4.0] and durations[2::3] == [2.0, 2.0]  # yellow, red
        assert sum(durations) < sum(d for _, d in net[tls].phases)  # Webster: shorter here
    engine = SimulationEngine(config, realtime=False, deadman_s=None)
    engine.open()
    try:
        state = run(engine, 3 * max(sum(d for _, d in t.phases) for t in tuned.values()))
        assert {s.program for s in state.snapshot.signals} == {PROGRAM_ID}
        assert state.safety.violations == 0 and state.safety.collisions == 0
    finally:
        engine.close()

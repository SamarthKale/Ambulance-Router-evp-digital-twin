"""Sprint 11: the replay telemetry. A recorder is passive (the run is the same run), and everything
it stores comes from the simulation (real SUMO, 2x2)."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any

import pandas as pd
import pytest

from evaluation.arms import Arm
from evaluation.runner import RunSpec, run_one
from evaluation.telemetry import (
    AMBULANCE_DT_S,
    SCHEMA_VERSION,
    TelemetryRecorder,
    continues,
    read_telemetry,
    telemetry_path,
    write_telemetry,
)
from scripts.record_telemetry import CHECKED, compare_with_recorded
from simulation.engine import SimulationEngine, SpawnAmbulance
from simulation.sumo import SumoConfig

SPEC = RunSpec("grid2x2", 1.0, 2, Arm("basic", "dynamic"), window_s=150)


@pytest.fixture(scope="module")
def recorded(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    folder = tmp_path_factory.mktemp("telemetry")
    plain = run_one(SPEC, folder / "plain")
    watched = run_one(SPEC, folder / "watched", TelemetryRecorder(traffic=True))
    return {"plain": plain["row"], "watched": watched["row"], "data": watched["telemetry"]}


def test_recording_does_not_change_the_run(recorded: dict[str, Any]) -> None:
    plain, watched = recorded["plain"], recorded["watched"]
    for name in CHECKED:
        assert plain[name] == watched[name], name  # identical metrics, hash and counters
    assert compare_with_recorded(watched, pd.Series(plain))["matches_recorded"]


def test_the_telemetry_agrees_with_the_run(recorded: dict[str, Any]) -> None:
    data, row = recorded["data"], recorded["watched"]
    assert data["schema_version"] == SCHEMA_VERSION
    assert data["arrived"] and data["mission_time"] == pytest.approx(row["travel_s"], abs=0.05)
    events = data["events"]
    assert events[0]["kind"] == "dispatch" and events[0]["t"] == 0.0
    (arrival,) = [e for e in events if e["kind"] == "arrival"]
    assert arrival["t"] == pytest.approx(data["mission_time"], abs=0.2)
    assert data["duration_s"] >= arrival["t"]  # it keeps recording a little after the arrival
    preempts = [e for e in events if e["kind"] == "preempt" and e["accepted"]]
    assert preempts and len(preempts) >= row["preemptions"]  # the controller's own log
    assert all(e["t"] >= 0 for e in events) and events == sorted(events, key=lambda e: e["t"])
    assert not [e for e in events if e["kind"] in ("collision", "violation")]  # row says none
    assert row["collisions"] == 0 and row["violations"] == 0


def test_the_ambulance_track_is_a_real_5_hz_trace(recorded: dict[str, Any]) -> None:
    data = recorded["data"]
    track = data["ambulance"]
    times = [s[0] for s in track]
    assert times == sorted(times) and times[0] == 0.0
    gaps = {round(b - a, 1) for a, b in zip(times, times[1:], strict=False)}
    assert min(gaps) >= 0.1 and max(gaps) <= AMBULANCE_DT_S + 0.1  # 5 Hz (+ the arrival tick)
    speeds = [s[4] for s in track]
    assert max(speeds) <= 22.1 and min(speeds) >= 0  # the ambulance's speed cap
    edges = data["ambulance_edges"]
    assert all(0 <= s[5] < len(edges) for s in track)
    assert edges[track[0][5]] == data["routes"][0]["edges"][0]  # starts on the route's first road
    assert data["routes"][0]["t"] == 0.0 and data["routes"][0]["edges"]


def test_signals_are_recorded_as_changes_with_the_controller_stage(
    recorded: dict[str, Any],
) -> None:
    signals = recorded["data"]["signals"]
    ids = signals["ids"]
    assert ids and len(signals["initial"]) == len(ids) == len(signals["initial_control"])
    changes = signals["changes"]
    assert changes and [c[0] for c in changes] == sorted(c[0] for c in changes)
    assert all(0 <= c[1] < len(ids) for c in changes)
    stages = {c[3] for c in changes}
    assert {"clearing", "preempted", "recovering"} <= stages  # BASIC preempted and recovered
    preempted = {ids[c[1]] for c in changes if c[3] == "preempted"}
    assert {e["junction"] for e in recorded["data"]["events"] if e["kind"] == "green"} >= preempted


def test_road_samples_and_traffic_are_consistent(recorded: dict[str, Any]) -> None:
    edges = recorded["data"]["edges"]
    n = len(edges["ids"])
    assert n > 0 and edges["samples"]
    for s in edges["samples"]:
        assert len(s["halting"]) == len(s["vehicles"]) == len(s["speed"]) == n
        assert all(h <= v for h, v in zip(s["halting"], s["vehicles"], strict=True))
    traffic = recorded["data"]["traffic"]
    assert traffic is not None and len(traffic["ids"]) == len(traffic["types"])
    for t, flat in traffic["samples"]:
        assert len(flat) % 4 == 0 and t >= 0
        assert all(0 <= flat[i] < len(traffic["ids"]) for i in range(0, len(flat), 4))
    assert "ambulance_01" not in traffic["ids"]  # the ambulance has its own track


def test_traffic_is_opt_in(tmp_path: Path) -> None:
    engine = SimulationEngine(
        SumoConfig(scenario="grid2x2", log_path=tmp_path / "sumo.log"),
        realtime=False,
        deadman_s=None,
        control="autopilot",
        warmup_s=60,
    )
    recorder = TelemetryRecorder()
    engine.open()
    try:
        engine.submit(SpawnAmbulance())
        for _ in range(30):
            recorder.observe(engine.tick())
    finally:
        engine.close()
    data = recorder.result()
    assert data["traffic"] is None and data["ambulance"] and data["edges"]["samples"]
    assert not data["arrived"] and data["mission_time"] is None


def test_files_are_gzip_json_and_deterministic(tmp_path: Path) -> None:
    data = {"schema_version": 1, "events": [{"t": 0.0, "kind": "dispatch"}], "x": [1.5, 2]}
    path = telemetry_path(tmp_path, "basic_static", "grid2x2_x1_seed001")
    first = write_telemetry(path, data)
    first_bytes = path.read_bytes()
    assert first == len(first_bytes) and json.loads(gzip.decompress(first_bytes)) == data
    assert read_telemetry(path) == data
    write_telemetry(path, data)
    assert path.read_bytes() == first_bytes  # same data, same bytes (git-friendly)
    assert not list(tmp_path.rglob("*.tmp"))


def test_continues_is_the_metrics_rule() -> None:
    assert continues(("a", "b", "c"), ("b", "c"))  # driven further along
    assert not continues(("a", "b", "c"), ("b", "d"))  # a different route
    assert not continues(("a", "b"), ("x", "b"))
    assert not continues(("a", "b"), ())


def test_verification_names_every_difference() -> None:
    row = {name: 1 for name in CHECKED} | {"approach_clear_s": float("nan")}
    same = pd.Series(row)
    assert compare_with_recorded(row, same) == {
        "matches_recorded": True,
        "checked": len(CHECKED),
        "differences": [],
    }  # NaN equals NaN
    other = pd.Series(row | {"travel_s": 2, "preemptions": 9})
    result = compare_with_recorded(row, other)
    assert not result["matches_recorded"] and len(result["differences"]) == 2
    assert result["differences"][0].startswith("travel_s: recorded 2")
    assert compare_with_recorded(row, None)["differences"] == ["no recorded row"]

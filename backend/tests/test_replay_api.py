"""Sprint 11: the recorded runs the replay dashboard reads (GET /api/replay/...)."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from api.protocol import ReplayRunMsg
from evaluation.arms import BASELINE, Arm
from evaluation.replay import build_index, load_run, run_key
from evaluation.report import load_runs, save_runs
from evaluation.telemetry import read_telemetry, telemetry_path, write_telemetry
from main import create_app
from simulation.engine import SimulationEngine
from simulation.sumo import REPO_ROOT, SumoConfig
from tests.test_results import fake_run

BASIC = Arm("basic", "static")
KEY = run_key("grid4x4", 1.5, 1)


def fake_telemetry(matches: bool = True) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "dispatch_s": 310.0,
        "duration_s": 12.0,
        "arrived": True,
        "mission_time": 7.0,
        "ambulance_edges": ["w0_A0", "A0_B0"],
        "ambulance": [[0.0, 0.0, 204.8, 90.0, 0.0, 0, 0], [7.0, 100.5, 204.8, 90.0, 15.2, 1, 1]],
        "status": [[0.0, 7.0, 90.0, "A0", "r"], [7.0, None, None, None, None]],
        "routes": [{"t": 0.0, "edges": ["w0_A0", "A0_B0"], "eta": 7.0, "routing": "static"}],
        "signals": {
            "ids": ["A0", "B0"],
            "initial": ["GGrr", "rrGG"],
            "initial_control": ["program", "program"],
            "changes": [[3.3, 0, "yyrr", "clearing"], [5.3, 0, "GGrr", "preempted"]],
        },
        "events": [
            {"t": 0.0, "kind": "dispatch", "junction": None, "edge": None, "text": "go",
             "accepted": None},
            {"t": 7.0, "kind": "arrival", "junction": None, "edge": None, "text": "arrived",
             "accepted": None},
        ],  # fmt: skip
        "edges": {
            "ids": ["w0_A0", "A0_B0"],
            "interval_s": 5.0,
            "samples": [{"t": 0.0, "halting": [0, 2], "vehicles": [1, 4], "speed": [9.5, 3.0]}],
        },
        "traffic": None,
        "incidents": [],
        "verification": {
            "matches_recorded": matches,
            "checked": 17,
            "differences": [] if matches else ["travel_s: recorded 7.0, re-run 8.0"],
        },
        "recorded_with": {
            "git_sha": "a" * 40,
            "git_dirty": False,
            "sumo_version": "Eclipse SUMO 1.27.1",
            "created_at": "2026-10-06T00:00:00+00:00",
        },
    }


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    engine = SimulationEngine(SumoConfig(log_path=tmp_path / "sumo.log"))
    app = create_app(engine)
    app.state.experiments_dir = tmp_path / "experiments"
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def experiments(tmp_path: Path) -> Path:
    out = tmp_path / "experiments"
    rows = [fake_run(BASELINE, 1, 200.0), fake_run(BASIC, 1, 120.0), fake_run(BASIC, 2, 110.0)]
    rows[1]["travel_s"] = 7.0
    rows[2]["approach_clear_s"] = float("nan")
    save_runs(out, rows)
    write_telemetry(telemetry_path(out / "telemetry", BASIC.id, KEY), fake_telemetry())
    return out


def test_no_runs_yet(client: TestClient) -> None:
    body = client.get("/api/replay/index").json()
    assert body["available"] is False and body["runs"] == []


def test_the_index_lists_every_run_and_marks_the_recorded_playbacks(
    client: TestClient, experiments: Path
) -> None:
    index = client.get("/api/replay/index").json()
    assert index["available"] and len(index["runs"]) == 3
    by_id = {r["id"]: r for r in index["runs"]}
    recorded = by_id[f"basic_static/{KEY}"]
    assert recorded["telemetry"] and recorded["matchesRecorded"] and recorded["strategy"] == "basic"
    assert recorded["summary"]["travelS"] == 7.0  # runs.csv is the authority
    other = by_id[f"basic_static/{run_key('grid4x4', 1.5, 2)}"]
    assert not other["telemetry"] and other["matchesRecorded"] is None and not other["traffic"]
    assert other["summary"]["approachClearS"] is None  # blank cell: null, never 0
    assert by_id[f"off_strict_static/{KEY}"]["summary"]["ambulanceCollisions"] == 0


def test_ambulance_collisions_come_from_the_classification(
    client: TestClient, experiments: Path
) -> None:
    """A run with collisions is 'not classified' until scripts.classify_collisions names the
    ambulance's events; a run SUMO saw no collision in has none."""
    rows = [fake_run(BASIC, 3, 100.0), fake_run(BASIC, 4, 100.0), fake_run(BASIC, 5, 100.0)]
    rows[0]["collisions"] = 3  # classified, the ambulance was involved
    rows[1]["collisions"] = 2  # not classified
    rows[2]["collisions"] = 1  # classified but did not reproduce: says nothing
    save_runs(experiments, rows)
    summary = experiments / "summary"
    summary.mkdir(parents=True, exist_ok=True)
    header = "scenario,scale,seed,arm,collisions,events,ambulance_events,red_crossings,travel_s"
    lines = [
        f"{header},reproduced",
        "grid4x4,1.5,3,basic_static,3,2,2,0,100.0,True",
        "grid4x4,1.5,5,basic_static,1,1,1,0,100.0,False",
    ]
    (summary / "collisions.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")
    runs = {r["id"]: r["summary"] for r in client.get("/api/replay/index").json()["runs"]}
    assert runs[f"basic_static/{run_key('grid4x4', 1.5, 3)}"]["ambulanceCollisions"] == 2
    assert runs[f"basic_static/{run_key('grid4x4', 1.5, 4)}"]["ambulanceCollisions"] is None
    assert runs[f"basic_static/{run_key('grid4x4', 1.5, 5)}"]["ambulanceCollisions"] is None
    assert runs[f"basic_static/{KEY}"]["ambulanceCollisions"] == 0  # no collision at all


def test_a_run_is_served_with_its_authoritative_summary(
    client: TestClient, experiments: Path
) -> None:
    body = client.get(f"/api/replay/runs/basic_static/{KEY}").json()
    assert body["id"] == f"basic_static/{KEY}" and body["strategy"] == "basic"
    assert body["routing"] == "static" and body["seed"] == 1 and body["scale"] == 1.5
    assert body["ambulanceEdges"] == ["w0_A0", "A0_B0"] and body["missionTime"] == 7.0
    assert body["signals"]["changes"][0] == [3.3, 0, "yyrr", "clearing"]
    assert body["summary"]["travelS"] == 7.0 and body["summary"]["preemptions"] == 0
    assert body["verification"]["matchesRecorded"] is True
    assert body["traffic"] is None and body["incidents"] == []


def test_a_mismatching_rerun_is_flagged_not_hidden(client: TestClient, experiments: Path) -> None:
    path = telemetry_path(experiments / "telemetry", BASIC.id, KEY)
    write_telemetry(path, fake_telemetry(matches=False))
    body = client.get(f"/api/replay/runs/basic_static/{KEY}").json()
    assert body["verification"]["matchesRecorded"] is False
    assert "travel_s" in body["verification"]["differences"][0]


@pytest.mark.parametrize(
    "arm, key",
    [
        ("basic_static", run_key("grid4x4", 1.5, 2)),  # in runs.csv, no telemetry
        ("turbo_static", KEY),  # unknown arm
        ("basic_static", "..%2f..%2fsecret"),  # path tricks
        ("basic_static", "grid4x4_x1.5_seed1"),  # not a run key
        ("..", KEY),
    ],
)
def test_unknown_runs_are_404(client: TestClient, experiments: Path, arm: str, key: str) -> None:
    assert client.get(f"/api/replay/runs/{arm}/{key}").status_code == 404


def test_corrupt_telemetry_is_an_error_not_a_fake_run(
    client: TestClient, experiments: Path
) -> None:
    path = telemetry_path(experiments / "telemetry", BASIC.id, KEY)
    broken = fake_telemetry()
    broken["ambulance"] = [[0.0, "x"]]
    write_telemetry(path, broken)
    assert client.get(f"/api/replay/runs/basic_static/{KEY}").status_code == 500


def test_big_responses_are_compressed(client: TestClient, experiments: Path) -> None:
    network = client.get("/api/replay/network/grid4x4", headers={"Accept-Encoding": "gzip"})
    assert network.headers["content-encoding"] == "gzip" and network.json()["lanes"]
    plain = client.get("/api/replay/network/grid4x4", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers
    assert network.num_bytes_downloaded < plain.num_bytes_downloaded / 3  # bytes on the wire


def test_the_network_comes_from_the_scenario(client: TestClient) -> None:
    body = client.get("/api/replay/network/grid4x4").json()
    assert body["lanes"] and body["hospital"]["edge"] and body["bounds"][2] > 600
    assert client.get("/api/replay/network/nowhere").status_code == 404
    assert client.get("/api/replay/network/..").status_code == 404


# ---- the real recordings (experiments/telemetry): integrity of what the dashboard shows ---------
RECORDED = REPO_ROOT / "experiments"
real = pytest.mark.skipif(
    not (RECORDED / "telemetry" / "index.json").exists(), reason="no recorded telemetry"
)


@real
def test_every_recorded_playback_reproduces_its_recorded_run() -> None:
    index = {r["id"]: r for r in build_index(RECORDED)["runs"]}
    with_telemetry = [r for r in index.values() if r["telemetry"]]
    assert len(with_telemetry) >= 40  # the demo scale is covered
    for run in with_telemetry:
        arm, key = run["id"].split("/")
        data = load_run(RECORDED, arm, key)
        assert data is not None
        msg = ReplayRunMsg.model_validate(data)  # the schema the frontend relies on
        assert msg.verification.matches_recorded, run["id"]  # re-run == runs.csv row
        assert msg.summary is not None and msg.summary.arrived == msg.arrived
        if msg.arrived:
            assert msg.mission_time == pytest.approx(msg.summary.travel_s, abs=0.05), run["id"]
        times = [s[0] for s in msg.ambulance]
        assert times == sorted(times) and msg.duration_s >= times[-1]
        assert msg.events[0].kind == "dispatch" and msg.events[0].t == 0.0


@real
def test_paired_runs_of_a_seed_start_from_the_same_traffic_and_place() -> None:
    """The ghost comparison relies on this: every arm of a seed starts at the same moment."""
    for seed in (1, 2, 3):
        starts = {}
        for arm in ("off_strict_static", "basic_static", "coord_dynamic"):
            data = read_telemetry(
                telemetry_path(RECORDED / "telemetry", arm, run_key("grid4x4", 1.5, seed))
            )
            starts[arm] = (data["dispatch_s"], tuple(data["ambulance"][0][1:4]))
        assert len(set(starts.values())) == 1, (seed, starts)
    runs = load_runs(RECORDED)
    assert len(runs) == 560  # the Sprint 9 results are untouched


@real
def test_the_dashboard_reports_the_published_ambulance_collisions() -> None:
    """22 collision events with the ambulance in 12 of 140 OFF-realistic runs, none elsewhere:
    the figures in the paper and the README, read from the classification."""
    events: dict[str, int] = {}
    runs_with: dict[str, int] = {}
    for run in build_index(RECORDED)["runs"]:
        count = run["summary"]["ambulance_collisions"]
        assert count is not None, run["id"]  # every run with a collision was classified
        events[run["strategy"]] = events.get(run["strategy"], 0) + count
        runs_with[run["strategy"]] = runs_with.get(run["strategy"], 0) + (count > 0)
    assert events == {"off_strict": 0, "off_realistic": 22, "basic": 0, "coord": 0}
    assert runs_with["off_realistic"] == 12

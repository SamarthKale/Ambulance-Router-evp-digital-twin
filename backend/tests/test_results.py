"""Sprint 9: the experiment summary the app's comparison chart reads (GET /api/results).

The summary is written by evaluation/report.py and served through the protocol models, so
the two must agree: checked here on synthetic runs (no SUMO needed for the report).
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from evaluation.arms import BASELINE, Arm
from evaluation.report import save_runs, write_report
from main import create_app
from simulation.engine import SimulationEngine
from simulation.sumo import SumoConfig


def fake_run(arm: Arm, seed: int, travel: float) -> dict[str, Any]:
    return {
        "scenario": "grid4x4", "scale": 1.5, "seed": seed, "arm": arm.id,
        "signals": arm.signals, "routing": arm.routing, "origin": "w0_A0",
        "destination": "D3_e3", "dispatch_s": 310.0, "trip_m": 1200.0, "window_s": 600.0,
        "signal_program": "tuned", "cycle_s": 35.0, "arrived": True, "travel_s": travel,
        "wait_s": travel / 4, "stops": 1, "red_stops": 1, "red_crossings": 0,
        "approach_clear_s": 3.0, "junctions_approached": 6, "queue_mean": 2.0,
        "bg_halted_s": 50000.0 + travel, "route_changes": 0, "preemptions": 0,
        "violations": 0, "collisions": 0, "dispatch_vehicles": 400,
        "dispatch_hash": f"h{seed}", "bg_time_loss_s": 100000.0 + 10 * travel,
        "bg_max_wait_s": 200.0, "bg_vehicles": 1800, "teleports": 0,
        "emergency_brakings": 0, "sumo_collision_warnings": 0, "valid": True, "wall_s": 60.0,
    }  # fmt: skip


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    engine = SimulationEngine(SumoConfig(log_path=tmp_path / "sumo.log"))
    app = create_app(engine)
    app.state.results_path = tmp_path / "experiments" / "summary" / "summary.json"
    with TestClient(app) as test_client:
        yield test_client


def test_no_results_yet(client: TestClient) -> None:
    body = client.get("/api/results").json()
    assert body["available"] is False and body["experiments"] == []


def test_the_report_summary_is_served_in_camel_case(client: TestClient, tmp_path: Path) -> None:
    basic = Arm("basic", "dynamic")
    rows = [fake_run(BASELINE, s, 200.0 + 10 * s) for s in range(1, 6)]
    rows += [fake_run(basic, s, 120.0 + 9 * s) for s in range(1, 6)]
    save_runs(tmp_path / "experiments", rows)
    write_report(tmp_path / "experiments")

    body = client.get("/api/results").json()
    assert body["available"] is True and body["baseline"] == BASELINE.id
    assert "travel_time_grid4x4_x1.5.png" in body["charts"]
    png = client.get("/api/charts/travel_time_grid4x4_x1.5.png")
    assert png.status_code == 200 and png.headers["content-type"] == "image/png"
    assert png.content[1:4] == b"PNG"  # the PNG signature
    assert client.get("/api/charts/..%2Fsummary.json").status_code == 404  # names only
    assert client.get("/api/charts/summary.json").status_code == 404
    (experiment,) = body["experiments"]
    assert experiment["pairingOk"] and experiment["signalProgram"] == "tuned"
    assert experiment["cycleS"] == 35.0 and experiment["seeds"] == [1, 2, 3, 4, 5]
    by_arm = {a["arm"]: a for a in experiment["arms"]}
    assert by_arm[BASELINE.id]["travelVsBaseline"] is None
    vs = by_arm["basic_dynamic"]["travelVsBaseline"]
    assert vs["n"] == 5 and vs["meanDiff"] == pytest.approx(-83.0)  # (120 + 9s) - (200 + 10s)
    assert vs["ci"][0] <= vs["meanDiff"] <= vs["ci"][1]
    assert vs["p"] == pytest.approx(0.0625)  # 5 pairs, all faster: the exact minimum
    assert by_arm["basic_dynamic"]["bgDelayVsBaseline"]["meanDiff"] == pytest.approx(-830.0)
    assert by_arm["basic_dynamic"]["safety"] == {
        "violations": 0, "collisions": 0, "emergencyBrakings": 0, "teleports": 0,
    }  # fmt: skip


def test_an_unreadable_summary_is_reported_not_raised(client: TestClient, tmp_path: Path) -> None:
    path = tmp_path / "experiments" / "summary" / "summary.json"
    path.parent.mkdir(parents=True)
    path.write_text('{"experiments": [{"scenario": 3}]}', encoding="utf-8")
    body = client.get("/api/results").json()
    assert body["available"] is False and "unreadable" in body["note"]

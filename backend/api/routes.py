"""HTTP routes: static network geometry, engine health, the batch experiment results and the
recorded runs the replay dashboard plays back."""

from __future__ import annotations

import functools
import json
import logging
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import ValidationError

from api.protocol import HealthMsg, NetworkMsg, ReplayIndexMsg, ReplayRunMsg, ResultsMsg
from evaluation.replay import build_index, load_run, valid_run
from simulation.engine import SimulationEngine
from simulation.network import RoadNetwork
from simulation.sumo import REPO_ROOT, SCENARIOS_DIR

log = logging.getLogger(__name__)
RESULTS = REPO_ROOT / "experiments" / "summary" / "summary.json"
CHART_NAME = re.compile(r"^[\w.-]+\.png$")
EXPERIMENTS = REPO_ROOT / "experiments"
SCENARIO_NAME = re.compile(r"^[A-Za-z0-9]+$")

router = APIRouter(prefix="/api")


@router.get("/network")
def network(request: Request) -> NetworkMsg:
    msg: NetworkMsg = request.app.state.network
    return msg


@router.get("/results")
def results(request: Request) -> ResultsMsg:
    """The experiment summary written by scripts.run_experiments (re-read on every request,
    so a new batch shows up without restarting)."""
    path: Path = getattr(request.app.state, "results_path", RESULTS)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        charts = sorted(p.name for p in path.parent.glob("*.png"))
        return ResultsMsg.model_validate({"available": True, **data, "charts": charts})
    except FileNotFoundError:
        return ResultsMsg(available=False, note="no experiment results yet")
    except (OSError, ValueError, ValidationError) as exc:
        log.warning("unreadable experiment summary %s: %s", path, exc)
        return ResultsMsg(available=False, note=f"unreadable experiment summary: {exc}")


@router.get("/charts/{name}")
def chart(name: str, request: Request) -> FileResponse:
    """A chart from experiments/summary/ (plain .png names only: no paths)."""
    folder: Path = getattr(request.app.state, "results_path", RESULTS).parent
    path = folder / name
    if not CHART_NAME.match(name) or not path.is_file():
        raise HTTPException(status_code=404, detail="no such chart")
    return FileResponse(path, media_type="image/png")


@router.get("/health")
def health(request: Request) -> HealthMsg:
    engine: SimulationEngine = request.app.state.engine
    latest = engine.latest
    if engine.error is not None:
        status = "error"
    elif engine.running and latest is not None:
        status = "running"
    else:
        status = "starting"
    stats = engine.stats()
    return HealthMsg(
        status=status,
        error=engine.error,
        seq=latest.seq if latest else None,
        t=latest.snapshot.time if latest else None,
        vehicles=stats.vehicles,
        tick_ms_p50=stats.tick_ms_p50,
        tick_ms_p95=stats.tick_ms_p95,
        tick_ms_max=stats.tick_ms_max,
        sumo_step_ms_p50=stats.sumo_step_ms_p50,
    )


# ---- replay: recorded experiment runs (Sprint 11) -----------------------------------------
def _experiments(request: Request) -> Path:
    folder: Path = getattr(request.app.state, "experiments_dir", EXPERIMENTS)
    return folder


@router.get("/replay/index")
def replay_index(request: Request) -> ReplayIndexMsg:
    """Every recorded run (runs.csv) and whether a playback was recorded for it. Re-read on every
    request, so newly recorded runs show up without restarting."""
    try:
        return ReplayIndexMsg.model_validate(build_index(_experiments(request)))
    except (OSError, ValueError, ValidationError) as exc:
        log.warning("unreadable experiment runs: %s", exc)
        return ReplayIndexMsg(available=False, note=f"unreadable experiment runs: {exc}")


@router.get("/replay/runs/{arm}/{key}")
def replay_run(arm: str, key: str, request: Request) -> ReplayRunMsg:
    """One run's telemetry with its authoritative result (404 when none was recorded)."""
    if not valid_run(arm, key):
        raise HTTPException(status_code=404, detail="no such run")
    try:
        data = load_run(_experiments(request), arm, key)
        if data is None:
            raise HTTPException(status_code=404, detail="no telemetry recorded for this run")
        return ReplayRunMsg.model_validate(data)
    except (OSError, ValueError, ValidationError) as exc:
        log.warning("unreadable telemetry %s/%s: %s", arm, key, exc)
        raise HTTPException(status_code=500, detail=f"unreadable telemetry: {exc}") from exc


@functools.cache
def _scenario_network(scenario: str) -> NetworkMsg:
    return NetworkMsg.model_validate(RoadNetwork(scenario).payload())


@router.get("/replay/network/{scenario}")
def replay_network(scenario: str) -> NetworkMsg:
    """The road geometry of a scenario's network (the recorded runs' map, which need not be the
    scenario the live server runs)."""
    if (
        not SCENARIO_NAME.match(scenario)
        or not (SCENARIOS_DIR / scenario / "network.net.xml").is_file()
    ):
        raise HTTPException(status_code=404, detail="no such scenario")
    return _scenario_network(scenario)

"""HTTP routes: static network geometry, engine health and the batch experiment results."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import ValidationError

from api.protocol import HealthMsg, NetworkMsg, ResultsMsg
from simulation.engine import SimulationEngine
from simulation.sumo import REPO_ROOT

log = logging.getLogger(__name__)
RESULTS = REPO_ROOT / "experiments" / "summary" / "summary.json"
CHART_NAME = re.compile(r"^[\w.-]+\.png$")

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

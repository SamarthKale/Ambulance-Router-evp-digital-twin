"""HTTP routes: static network geometry and engine health."""

from __future__ import annotations

from fastapi import APIRouter, Request

from api.protocol import HealthMsg, NetworkMsg
from simulation.engine import SimulationEngine

router = APIRouter(prefix="/api")


@router.get("/network")
def network(request: Request) -> NetworkMsg:
    msg: NetworkMsg = request.app.state.network
    return msg


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
    return HealthMsg(
        status=status,
        error=engine.error,
        seq=latest.seq if latest else None,
        t=latest.snapshot.time if latest else None,
    )

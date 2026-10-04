"""FastAPI entry point. From backend/:
.venv\\Scripts\\python.exe -m uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI

from api.protocol import NetworkMsg
from api.routes import router as api_router
from api.websocket import Broadcaster
from api.websocket import router as ws_router
from simulation.engine import SimulationEngine
from simulation.sumo import REPO_ROOT, SumoConfig


def engine_from_env() -> SimulationEngine:
    load_dotenv(REPO_ROOT / ".env")
    config = SumoConfig(
        scenario=os.environ.get("EF_SCENARIO", "grid2x2"),
        seed=int(os.environ.get("EF_SEED", "42")),
        scale=float(os.environ.get("EF_SCALE", "1.0")),
    )
    return SimulationEngine(config)


def create_app(engine: SimulationEngine | None = None) -> FastAPI:
    engine = engine or engine_from_env()
    broadcaster = Broadcaster()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        loop = asyncio.get_running_loop()
        engine.start(lambda state: loop.call_soon_threadsafe(broadcaster.publish, state))
        yield
        await asyncio.to_thread(engine.stop)  # closes SUMO

    app = FastAPI(title="EmergencyFlow AI", version="0.2.0", lifespan=lifespan)
    app.state.engine = engine
    app.state.broadcaster = broadcaster
    app.state.network = NetworkMsg.model_validate(engine.network.payload())
    app.include_router(api_router)
    app.include_router(ws_router)
    return app


app = create_app()

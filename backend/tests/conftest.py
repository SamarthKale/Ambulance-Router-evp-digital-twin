from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from simulation.sumo import SumoConfig, SumoSimulation

SimFactory = Callable[..., SumoSimulation]


@pytest.fixture
def make_sim(tmp_path: Path) -> Iterator[SimFactory]:
    """Build simulations that log to tmp_path and are always closed after the test."""
    created: list[SumoSimulation] = []

    def factory(seed: int = 42, scale: float = 1.0) -> SumoSimulation:
        log = tmp_path / f"sumo_{len(created)}.log"
        sim = SumoSimulation(SumoConfig(seed=seed, scale=scale, log_path=log))
        created.append(sim)
        return sim

    yield factory
    for sim in created:
        sim.close()  # safety net if a test failed mid-run

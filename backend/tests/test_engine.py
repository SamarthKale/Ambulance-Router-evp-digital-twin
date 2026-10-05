"""Sprint 2: the engine thread paces SUMO at 10 Hz, survives a SUMO crash, stops cleanly."""

from __future__ import annotations

import threading
import time
from pathlib import Path

import psutil

from simulation.engine import EngineState, SimulationEngine, SpawnAmbulance
from simulation.sumo import SumoConfig


def wait_for(condition: object, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():  # type: ignore[operator]
            return True
        time.sleep(0.05)
    return False


def test_thread_runs_at_10_hz_and_stops_without_orphans(tmp_path: Path) -> None:
    states: list[EngineState] = []
    engine = SimulationEngine(SumoConfig(log_path=tmp_path / "sumo.log"))
    engine.start(states.append)
    try:
        assert wait_for(lambda: len(states) > 0, 10)
        pid = engine.sumo_pid
        first = len(states)
        time.sleep(2.0)
        rate = (len(states) - first) / 2.0
        assert 8.5 <= rate <= 11.5, f"{rate} ticks/s"
        seqs = [s.seq for s in states]
        assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
        # commands from another thread run on the engine thread
        assert engine.submit(SpawnAmbulance()).result(timeout=2).ok
    finally:
        engine.stop()
    assert pid is not None and not psutil.pid_exists(pid)
    assert not any(t.name == "sumo-engine" for t in threading.enumerate())


def test_monitor_knows_the_warm_up_history(tmp_path: Path) -> None:
    """Regression (Sprint 6): the monitor used to start after the warm-up. Ending the warm-up
    in an all-red (35-37 s of the 74 s cycle) made the next normal green look like a
    clearance shorter than 2 s, a false R3 violation."""
    engine = SimulationEngine(
        SumoConfig(log_path=tmp_path / "sumo.log"), realtime=False, warmup_s=36.5
    )
    engine.open()
    try:
        for _ in range(30):
            state = engine.tick()
        assert state.safety.violations == 0
    finally:
        engine.close()


def test_engine_restarts_sumo_after_a_crash(tmp_path: Path) -> None:
    states: list[EngineState] = []
    engine = SimulationEngine(SumoConfig(log_path=tmp_path / "sumo.log"))
    engine.start(states.append)
    try:
        assert wait_for(lambda: engine.sumo_pid is not None and len(states) > 5, 10)
        crashed_pid = engine.sumo_pid
        assert crashed_pid is not None
        psutil.Process(crashed_pid).kill()  # simulate SUMO dying mid-run
        assert wait_for(lambda: engine.error is not None, 5), "crash not noticed"
        assert wait_for(
            lambda: engine.sumo_pid not in (None, crashed_pid) and engine.error is None, 10
        ), "SUMO was not restarted"
        before = len(states)
        assert wait_for(lambda: len(states) > before + 5, 5), "no ticks after restart"
    finally:
        engine.stop()

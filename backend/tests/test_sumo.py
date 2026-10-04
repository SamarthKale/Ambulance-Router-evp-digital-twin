"""Sprint 1: the SUMO world runs headless, has traffic, cycles its signals, shuts down cleanly."""

from __future__ import annotations

import subprocess
import sys
import textwrap
import xml.etree.ElementTree as ET
from collections.abc import Callable
from pathlib import Path

import psutil
import pytest

from simulation.sumo import STEP_LENGTH, SumoConfig, SumoSimulation, find_sumo_binary

SimFactory = Callable[..., SumoSimulation]  # the make_sim fixture in conftest.py
BACKEND_DIR = Path(__file__).resolve().parents[1]
EXPECTED_TLS = ("A0", "A1", "B0", "B1")
CYCLE_S = 74.0  # 2 x (31 s green + 4 s yellow + 2 s all-red)


def test_vehicles_exist_after_100_steps(make_sim: SimFactory) -> None:
    with make_sim() as sim:
        snaps = [sim.step() for _ in range(100)]
    last = snaps[-1]
    assert last.time == pytest.approx(100 * STEP_LENGTH)
    assert last.vehicle_count > 0
    assert tuple(s.tls_id for s in last.signals) == EXPECTED_TLS


def test_signals_cycle_through_every_phase_in_74_s(make_sim: SimFactory) -> None:
    """One 74 s cycle visits every phase, each for exactly its programmed duration.

    SUMO reports a phase change one step after its nominal start (the state read at
    time t governed the step ending at t), so the cycle is observed from 0.1 s to 74.1 s.
    """
    with make_sim() as sim:
        programs = {tls: sim.signal_program(tls) for tls in sim.tls_ids}
        for tls, phases in programs.items():
            assert sum(d for _, d in phases) == pytest.approx(CYCLE_S), tls

        start = sim.snapshot()
        last_phase = {s.tls_id: s.phase for s in start.signals}
        switches: dict[str, list[tuple[float, int]]] = {tls: [] for tls in sim.tls_ids}
        for _ in range(round(CYCLE_S / STEP_LENGTH) + 1):
            snap = sim.step()
            for sig in snap.signals:
                assert sig.state == programs[sig.tls_id][sig.phase][0]
                if sig.phase != last_phase[sig.tls_id]:
                    switches[sig.tls_id].append((snap.time, sig.phase))
                    last_phase[sig.tls_id] = sig.phase

    assert snap.signals == start.signals  # one full cycle later, back at the start
    for tls, phases in programs.items():
        observed = switches[tls]
        assert [p for _, p in observed] == [*range(1, len(phases)), 0], tls
        assert observed[0][0] == pytest.approx(phases[0][1] + STEP_LENGTH), tls
        for (t0, phase), (t1, _) in zip(observed, observed[1:], strict=False):
            assert t1 - t0 == pytest.approx(phases[phase][1]), (tls, phase)


def test_every_green_ends_with_yellow_then_all_red(make_sim: SimFactory) -> None:
    """Baseline programs honour the clearance rule in CLAUDE.md section 7."""
    with make_sim() as sim:
        programs = {tls: sim.signal_program(tls) for tls in sim.tls_ids}
    for tls, phases in programs.items():
        for i, (state, _) in enumerate(phases):
            if "G" not in state and "g" not in state:
                continue
            yellow, yellow_s = phases[(i + 1) % len(phases)]
            all_red, all_red_s = phases[(i + 2) % len(phases)]
            assert set(yellow) <= {"y", "r"} and "y" in yellow, (tls, i)
            assert yellow_s == 4.0, (tls, i)
            assert set(all_red) == {"r"} and all_red_s == 2.0, (tls, i)


def test_close_leaves_no_sumo_process(make_sim: SimFactory) -> None:
    sim = make_sim()
    sim.start()
    pid = sim.pid
    assert pid is not None and psutil.pid_exists(pid)
    sim.step()
    sim.close()
    assert sim.exit_code == 0
    assert not psutil.pid_exists(pid)
    sim.close()  # idempotent


def test_hard_killed_client_does_not_orphan_sumo(tmp_path: Path) -> None:
    """Kill the Python client with no cleanup at all; SUMO must notice and exit by itself."""
    child_code = textwrap.dedent(f"""
        import time
        from pathlib import Path
        from simulation.sumo import SumoConfig, SumoSimulation
        sim = SumoSimulation(SumoConfig(log_path=Path(r"{tmp_path}") / "child.log"))
        sim.start()
        sim.step()
        print(sim.pid, flush=True)
        time.sleep(60)
    """)
    child = subprocess.Popen(
        [sys.executable, "-c", child_code], cwd=BACKEND_DIR, stdout=subprocess.PIPE, text=True
    )
    assert child.stdout is not None
    sumo_pid = int(child.stdout.readline())
    child.kill()  # TerminateProcess on Windows: no atexit, no finally
    child.wait(timeout=10)
    try:
        psutil.Process(sumo_pid).wait(timeout=10)
    except psutil.NoSuchProcess:
        pass  # already gone
    except psutil.TimeoutExpired:
        psutil.Process(sumo_pid).kill()  # don't leave an orphan behind the failing test
        pytest.fail("sumo kept running after its TraCI client was killed")


def test_same_seed_reproduces_and_other_seed_differs(make_sim: SimFactory) -> None:
    def vehicle_counts(seed: int) -> list[int]:
        with make_sim(seed=seed) as sim:
            return [sim.step().vehicle_count for _ in range(300)]

    first = vehicle_counts(42)
    assert vehicle_counts(42) == first
    assert vehicle_counts(7) != first


@pytest.mark.slow
def test_one_hour_heavy_traffic_has_no_collisions_or_teleports(tmp_path: Path) -> None:
    """Scenario quality: 1 simulated hour at 1.5x (heavy-traffic demo) demand."""
    stats = tmp_path / "stats.xml"
    config = SumoConfig(scale=1.5)
    # fmt: off
    cmd = [
        str(find_sumo_binary()),
        "-c", str(config.sumocfg),
        "--scale", str(config.scale),
        "--seed", str(config.seed),
        "--statistic-output", str(stats),
    ]
    # fmt: on
    subprocess.run(cmd, check=True, capture_output=True)
    root = ET.parse(stats).getroot()
    vehicles, teleports, safety = (root.find(t) for t in ("vehicles", "teleports", "safety"))
    assert vehicles is not None and teleports is not None and safety is not None
    assert int(vehicles.get("inserted", "0")) > 4000
    assert teleports.get("total") == "0"
    assert safety.get("collisions") == "0"


def inserted_between(routes: str, begin: int, end: int, tmp_path: Path) -> int:
    config = SumoConfig()
    stats = tmp_path / f"{routes}.stats.xml"
    # fmt: off
    cmd = [
        str(find_sumo_binary()),
        "-n", str(config.net_path),
        "-r", str(config.sumocfg.parent / routes),
        "--begin", str(begin), "--end", str(end),
        "--statistic-output", str(stats),
    ]
    # fmt: on
    subprocess.run(cmd, check=True, capture_output=True)
    vehicles = ET.parse(stats).getroot().find("vehicles")
    assert vehicles is not None
    return int(vehicles.get("inserted", "0"))


def test_live_traffic_continues_past_one_hour_but_experiments_stop(tmp_path: Path) -> None:
    """Live demo demand runs 24 h; the experiment demand stays exactly 1 h."""
    assert inserted_between("routes.live.rou.xml", 7200, 7320, tmp_path) > 20
    assert inserted_between("routes.live.rou.xml", 86000, 86120, tmp_path) > 20
    assert inserted_between("routes.rou.xml", 7200, 7320, tmp_path) == 0

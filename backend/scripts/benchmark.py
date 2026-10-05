"""Performance check (Sprint 4): engine tick time, state message size, vehicle count.

For each scenario/demand: warm up to steady traffic, dispatch the ambulance in BASIC mode
at full throttle (so the safety controller works too), then measure MEASURE_S of ticks.
The live loop has a 100 ms budget per tick (10 Hz).

    .venv\\Scripts\\python.exe -m scripts.benchmark [--warmup 600] [--measure 60]
"""

from __future__ import annotations

import argparse
import statistics
import sys
import tempfile
import time
import zlib
from dataclasses import dataclass
from pathlib import Path

from api.protocol import state_message
from simulation.engine import Drive, SimulationEngine, SpawnAmbulance
from simulation.sumo import STEP_LENGTH, SumoConfig

CASES = (("grid2x2", 1.0), ("grid2x2", 1.5), ("grid4x4", 1.0), ("grid4x4", 1.5))
TICK_BUDGET_MS = STEP_LENGTH * 1000


@dataclass(frozen=True)
class BenchResult:
    scenario: str
    scale: float
    vehicles_mean: float
    vehicles_max: int
    tick_ms_p50: float
    tick_ms_p95: float
    tick_ms_max: float
    sumo_step_ms_p50: float
    serialize_ms_p50: float
    message_kb_p50: float
    message_kb_max: float
    deflated_kb_p50: float  # approximates the wire size with WebSocket per-message deflate


def pct(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))]


def bench(scenario: str, scale: float, warmup_s: float, measure_s: float) -> BenchResult:
    log = Path(tempfile.gettempdir()) / f"ef_bench_{scenario}_{scale}.log"
    engine = SimulationEngine(
        SumoConfig(scenario=scenario, scale=scale, log_path=log, routes="routes.live.rou.xml"),
        realtime=False,
        deadman_s=None,
        mode="BASIC",
        warmup_s=warmup_s,
    )
    engine.open()
    try:
        engine.submit(SpawnAmbulance())
        engine.submit(Drive(throttle=1, brake=0))
        ticks, steps, serialize, sizes, deflated, vehicles = [], [], [], [], [], []
        for _ in range(round(measure_s / STEP_LENGTH)):
            started = time.perf_counter()
            state = engine.tick()
            ticks.append((time.perf_counter() - started) * 1000)
            started = time.perf_counter()
            text = state_message(state).model_dump_json()
            serialize.append((time.perf_counter() - started) * 1000)
            raw = text.encode()
            sizes.append(len(raw) / 1024)
            deflated.append(len(zlib.compress(raw, 6)) / 1024)
            vehicles.append(state.snapshot.vehicle_count)
        steps = list(engine._step_ms)  # noqa: SLF001 - benchmark reads the engine's own split
        return BenchResult(
            scenario=scenario,
            scale=scale,
            vehicles_mean=round(statistics.mean(vehicles), 1),
            vehicles_max=max(vehicles),
            tick_ms_p50=round(pct(ticks, 0.5), 2),
            tick_ms_p95=round(pct(ticks, 0.95), 2),
            tick_ms_max=round(max(ticks), 2),
            sumo_step_ms_p50=round(pct(steps, 0.5), 2),
            serialize_ms_p50=round(pct(serialize, 0.5), 2),
            message_kb_p50=round(pct(sizes, 0.5), 1),
            message_kb_max=round(max(sizes), 1),
            deflated_kb_p50=round(pct(deflated, 0.5), 1),
        )
    finally:
        engine.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Engine tick time and message size")
    parser.add_argument("--warmup", type=float, default=600.0, help="simulated seconds")
    parser.add_argument("--measure", type=float, default=60.0, help="simulated seconds")
    args = parser.parse_args(argv)
    print(f"budget: {TICK_BUDGET_MS:.0f} ms per tick; warm-up {args.warmup:g} s, "
          f"measured {args.measure:g} s, BASIC mode, ambulance driving")  # fmt: skip
    print(
        f"{'scenario':9} {'scale':>5} {'veh mean':>8} {'veh max':>7} {'tick p50':>8} "
        f"{'tick p95':>8} {'tick max':>8} {'sumo p50':>8} {'json p50':>8} "
        f"{'msg KB p50':>10} {'msg KB max':>10} {'deflated KB':>11}"
    )
    for scenario, scale in CASES:
        r = bench(scenario, scale, args.warmup, args.measure)
        print(
            f"{r.scenario:9} {r.scale:>5} {r.vehicles_mean:>8} {r.vehicles_max:>7} "
            f"{r.tick_ms_p50:>8} {r.tick_ms_p95:>8} {r.tick_ms_max:>8} {r.sumo_step_ms_p50:>8} "
            f"{r.serialize_ms_p50:>8} {r.message_kb_p50:>10} {r.message_kb_max:>10} "
            f"{r.deflated_kb_p50:>11}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())

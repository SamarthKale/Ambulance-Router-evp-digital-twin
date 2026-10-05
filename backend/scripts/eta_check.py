"""How good is the routing ETA? Predicted at dispatch vs measured, over seeded autopilot runs.

For each seed: warm up (traffic in steady state), dispatch at a seeded random moment, let
the autopilot follow the suggested route, and compare the ETA predicted when the first
route was planned with the measured mission time. Runs in parallel SUMO processes.

    .venv\\Scripts\\python.exe -m scripts.eta_check [--scenario grid4x4] [--seeds 10]
        [--scale 1.0] [--modes OFF BASIC]

Writes experiments/eta/eta_check.csv. These are autopilot results (CLAUDE.md section 14).
"""

from __future__ import annotations

import argparse
import csv
import os
import random
import statistics
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path

from simulation.engine import Mode, SimulationEngine, SpawnAmbulance
from simulation.sumo import REPO_ROOT, STEP_LENGTH, SumoConfig

OUT_DIR = REPO_ROOT / "experiments" / "eta"
WARMUP_S = 300.0
DISPATCH_JITTER_S = 120.0
MISSION_LIMIT_S = 900.0


@dataclass(frozen=True)
class EtaRun:
    scenario: str
    scale: float
    seed: int
    mode: str
    dispatch_s: float
    predicted_s: float | None  # ETA when the first route was planned (+ time since dispatch)
    actual_s: float | None  # measured mission time
    route: str
    violations: int
    collisions: int

    @property
    def error_s(self) -> float | None:
        if self.predicted_s is None or self.actual_s is None:
            return None
        return self.predicted_s - self.actual_s


def run_one(scenario: str, scale: float, seed: int, mode: Mode) -> EtaRun:
    dispatch = WARMUP_S + random.Random(seed).uniform(0.0, DISPATCH_JITTER_S)
    log = Path(tempfile.gettempdir()) / f"ef_eta_{scenario}_{scale}_{seed}_{mode}.log"
    engine = SimulationEngine(
        SumoConfig(scenario=scenario, seed=seed, scale=scale, log_path=log),
        realtime=False,
        deadman_s=None,
        mode=mode,
        control="autopilot",
        warmup_s=dispatch,
    )
    engine.open()
    try:
        engine.submit(SpawnAmbulance())
        predicted = actual = None
        route = ""
        state = engine.tick()
        for _ in range(round(MISSION_LIMIT_S / STEP_LENGTH)):
            state = engine.tick()
            if predicted is None and state.route is not None:
                predicted = state.route.eta_s + (state.ambulance.mission_time or 0.0)
                route = " ".join(state.route.edges)
            if state.ambulance.status == "arrived":
                actual = state.ambulance.mission_time
                break
        return EtaRun(
            scenario=scenario,
            scale=scale,
            seed=seed,
            mode=mode,
            dispatch_s=round(dispatch, 1),
            predicted_s=None if predicted is None else round(predicted, 1),
            actual_s=None if actual is None else round(actual, 1),
            route=route,
            violations=state.safety.violations,
            collisions=state.safety.collisions,
        )
    finally:
        engine.close()


def summarise(runs: list[EtaRun]) -> list[str]:
    lines = [f"{'mode':6} {'runs':>4} {'MAE s':>6} {'MAPE %':>7} {'bias s':>7} {'worst s':>8}"]
    for mode in sorted({r.mode for r in runs}):
        errors = [(r.error_s, r.actual_s) for r in runs if r.mode == mode and r.error_s is not None]
        if not errors:
            lines.append(f"{mode:6} {0:>4}")
            continue
        abs_err = [abs(e) for e, _ in errors]
        mape = statistics.mean(abs(e) / a * 100 for e, a in errors if a)
        bias = statistics.mean(e for e, _ in errors)
        lines.append(
            f"{mode:6} {len(errors):>4} {statistics.mean(abs_err):>6.1f} {mape:>7.1f} "
            f"{bias:>+7.1f} {max(abs_err):>8.1f}"
        )
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Routing ETA: predicted vs measured")
    parser.add_argument("--scenario", default="grid4x4")
    parser.add_argument("--seeds", type=int, default=10)
    parser.add_argument("--scale", type=float, default=1.0)
    parser.add_argument("--modes", nargs="+", default=["OFF", "BASIC"])
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    args = parser.parse_args(argv)
    jobs = [(args.scenario, args.scale, s, m) for s in range(1, args.seeds + 1) for m in args.modes]
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        runs = list(pool.map(run_one, *zip(*jobs, strict=True)))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "eta_check.csv"
    with out.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[*asdict(runs[0]), "error_s"])
        writer.writeheader()
        for r in runs:
            writer.writerow({**asdict(r), "error_s": r.error_s})
    print(f"ETA check: {args.scenario} x{args.scale}, seeds 1-{args.seeds}, autopilot, "
          f"dynamic routing (predicted at dispatch vs measured)")  # fmt: skip
    for line in summarise(runs):
        print(line)
    unsafe = [r for r in runs if r.violations or r.collisions]
    print(f"safety: {len(unsafe)} runs with violations or collisions; wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

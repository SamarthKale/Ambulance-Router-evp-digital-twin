"""Record time-series telemetry for the replay dashboard (Sprint 11).

    .venv\\Scripts\\python.exe -m scripts.record_telemetry --scales 1.5 --seeds 1-5
    .venv\\Scripts\\python.exe -m scripts.record_telemetry --scales 0.75,1.0,2.0 --seeds 1-2
    .venv\\Scripts\\python.exe -m scripts.record_telemetry --scales 1.5 --seeds 1 --traffic-seeds 1

The Sprint 9 batch kept only aggregates. This re-runs the same runs (same code path, same seed,
same tuned signal program: SUMO is deterministic) with a passive recorder watching, writes
experiments/telemetry/<arm>/<run>.json.gz and compares every re-run's metrics with the row already
in experiments/<arm>/runs.csv. runs.csv is never modified: it stays the authoritative result.
A run whose re-run differs is stored anyway and flagged (verification.matches_recorded = false), so
the dashboard says so instead of presenting it as the recorded run.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import tempfile
import time
from concurrent.futures import Future, ProcessPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd

from evaluation.arms import parse_arms
from evaluation.programs import tuned_program
from evaluation.report import load_runs
from evaluation.runner import WINDOW_S, RunSpec, git_state, run_one, sumo_version
from evaluation.telemetry import TelemetryRecorder, telemetry_path, write_telemetry
from scripts.run_experiments import parse_seeds
from simulation.sumo import REPO_ROOT

OUT = REPO_ROOT / "experiments"
INDEX = "index.json"
# What must be identical between the recorded run and its re-run (everything the dashboard
# shows next to the telemetry comes from these).
CHECKED = (
    "dispatch_hash", "arrived", "travel_s", "wait_s", "stops", "red_stops", "red_crossings",
    "approach_clear_s", "queue_mean", "bg_halted_s", "route_changes", "preemptions",
    "violations", "collisions", "bg_time_loss_s", "emergency_brakings", "teleports",
)  # fmt: skip


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, float) or isinstance(b, float):
        try:
            fa, fb = float(a), float(b)
        except (TypeError, ValueError):
            return False
        return (math.isnan(fa) and math.isnan(fb)) or abs(fa - fb) < 1e-6
    return bool(a == b)


def compare_with_recorded(row: dict[str, Any], recorded: pd.Series | None) -> dict[str, Any]:
    """Which checked fields of the re-run differ from the runs.csv row."""
    if recorded is None:
        return {"matches_recorded": False, "checked": 0, "differences": ["no recorded row"]}
    differences = []
    for name in CHECKED:
        if not _same(row.get(name), recorded.get(name)):
            differences.append(f"{name}: recorded {recorded.get(name)}, re-run {row.get(name)}")
    return {
        "matches_recorded": not differences,
        "checked": len(CHECKED),
        "differences": differences,
    }


def _work(spec: RunSpec, traffic: bool) -> dict[str, Any]:
    folder = Path(tempfile.mkdtemp(prefix="ef_tel_"))
    try:
        recorder = TelemetryRecorder(traffic=traffic)
        result = run_one(spec, folder, recorder)
        return {"row": result["row"], "telemetry": result["telemetry"]}
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def load_index(out: Path) -> dict[str, Any]:
    path = out / "telemetry" / INDEX
    if path.exists():
        data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        return data
    return {"runs": {}}


def save_index(out: Path, index: dict[str, Any]) -> None:
    index["generated_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    folder = out / "telemetry"
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / (INDEX + ".tmp")
    tmp.write_text(json.dumps(index, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, folder / INDEX)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--scenario", default="grid4x4")
    parser.add_argument("--scales", default="1.5", help="comma-separated demand multipliers")
    parser.add_argument("--seeds", default="1-5", help="e.g. 1-5 or 1,2,5")
    parser.add_argument("--arms", default="all", help="'all' or comma-separated arm ids")
    parser.add_argument(
        "--traffic-seeds",
        default="",
        help="seeds whose runs also record the background traffic at 1 Hz (larger files)",
    )
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 4))
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--rerun", action="store_true", help="record runs that already have a file")
    args = parser.parse_args(argv)

    out: Path = args.out
    folder = out / "telemetry"
    arms = parse_arms(args.arms)
    scales = [float(s) for s in args.scales.split(",")]
    seeds = parse_seeds(args.seeds)
    traffic_seeds = set(parse_seeds(args.traffic_seeds))
    recorded = load_runs(out)
    if recorded.empty:
        print(f"no recorded runs under {out}: run scripts.run_experiments first", file=sys.stderr)
        return 1
    programs = {s: tuned_program(args.scenario, s, out) for s in scales}
    candidates = [
        RunSpec(args.scenario, scale, seed, arm, WINDOW_S, programs[scale])
        for scale in scales
        for seed in seeds
        for arm in arms
    ]
    specs = [
        s for s in candidates if args.rerun or not telemetry_path(folder, s.arm.id, s.key).exists()
    ]
    print(f"{len(specs)} runs to record ({args.workers} workers)", flush=True)
    index = load_index(out)
    sha, dirty = git_state()
    failures = mismatches = 0
    started = time.perf_counter()
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures: dict[Future[dict[str, Any]], RunSpec] = {
            pool.submit(_work, spec, spec.seed in traffic_seeds): spec for spec in specs
        }
        for i, future in enumerate(as_completed(futures), start=1):
            spec = futures[future]
            try:
                result = future.result()
            except Exception as exc:  # one broken run must not lose the others
                failures += 1
                print(f"[{i}/{len(specs)}] {spec.arm.id} {spec.key} FAILED: {exc}", flush=True)
                continue
            match = recorded[
                (recorded["scenario"] == spec.scenario)
                & (recorded["scale"] == spec.scale)
                & (recorded["seed"] == spec.seed)
                & (recorded["arm"] == spec.arm.id)
            ]
            verification = compare_with_recorded(
                result["row"], None if match.empty else match.iloc[0]
            )
            data = result["telemetry"]
            data["verification"] = verification
            data["recorded_with"] = {
                "git_sha": sha,
                "git_dirty": dirty,
                "sumo_version": sumo_version(),
                "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
            }
            size = write_telemetry(telemetry_path(folder, spec.arm.id, spec.key), data)
            index["runs"][f"{spec.arm.id}/{spec.key}"] = {
                "bytes": size,
                "duration_s": data["duration_s"],
                "traffic": data["traffic"] is not None,
                "matches_recorded": verification["matches_recorded"],
                "differences": verification["differences"],
            }
            save_index(out, index)
            if not verification["matches_recorded"]:
                mismatches += 1
            flag = (
                ""
                if verification["matches_recorded"]
                else "  DIFFERS: " + "; ".join(verification["differences"][:3])
            )
            print(
                f"[{i}/{len(specs)}] {spec.arm.id:<22} {spec.key}  {size / 1024:6.0f} KB"
                f"  ({(time.perf_counter() - started) / 60:.1f} min){flag}",
                flush=True,
            )  # fmt: skip
    print(
        f"\ndone: {len(specs) - failures} recorded, {mismatches} differ from runs.csv, "
        f"{failures} failed"
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

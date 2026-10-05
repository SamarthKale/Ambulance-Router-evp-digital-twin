"""Batch experiments (CLAUDE.md section 14): every arm on the same seeded missions, in parallel
headless SUMO processes, then paired statistics and charts under experiments/.

    .venv\\Scripts\\python.exe -m scripts.run_experiments --scales 1.5 --seeds 1-20
    .venv\\Scripts\\python.exe -m scripts.run_experiments --scales 0.75,1.0,1.5,2.0 --seeds 1-10
    .venv\\Scripts\\python.exe -m scripts.run_experiments --report-only

Runs already in experiments/<arm>/runs.csv are skipped (pass --rerun to repeat them).
--ci-target S keeps adding seeds (in batches) until every arm's 95 % CI of the mean travel
time difference against the baseline is at most +-S seconds wide, or --max-seeds is reached.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
import time
from concurrent.futures import Future, ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from evaluation.arms import BASELINE, parse_arms
from evaluation.programs import tuned_program
from evaluation.report import (
    done_keys,
    load_runs,
    paired_table,
    save_manifest,
    save_runs,
    write_report,
)
from evaluation.runner import WINDOW_S, RunSpec, run_one
from simulation.sumo import REPO_ROOT

OUT = REPO_ROOT / "experiments"


def parse_seeds(text: str) -> list[int]:
    seeds: list[int] = []
    for part in text.split(","):
        if "-" in part:
            a, b = part.split("-")
            seeds.extend(range(int(a), int(b) + 1))
        elif part.strip():
            seeds.append(int(part))
    return seeds


def _work(spec: RunSpec, raw: Path | None) -> dict[str, Any]:
    folder = (raw / spec.arm.id / spec.key) if raw else Path(tempfile.mkdtemp(prefix="ef_run_"))
    try:
        return run_one(spec, folder)
    finally:
        if raw is None:
            shutil.rmtree(folder, ignore_errors=True)


def run_batch(specs: list[RunSpec], workers: int, out: Path, raw: Path | None) -> int:
    failures = 0
    started = time.perf_counter()
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures: dict[Future[dict[str, Any]], RunSpec] = {
            pool.submit(_work, spec, raw): spec for spec in specs
        }
        for i, future in enumerate(as_completed(futures), start=1):
            spec = futures[future]
            try:
                result = future.result()
            except Exception as exc:  # one broken run must not lose the others
                failures += 1
                print(f"[{i}/{len(specs)}] {spec.arm.id} {spec.key} FAILED: {exc}", flush=True)
                continue
            row = result["row"]
            save_runs(out, [row])
            save_manifest(out, result["manifest"])
            travel = "-" if row["travel_s"] is None else f"{row['travel_s']:.1f} s"
            flags = "" if row["valid"] else "  (excluded: not arrived or teleports)"
            elapsed = time.perf_counter() - started
            print(
                f"[{i}/{len(specs)}] {spec.arm.id:<22} {spec.key}  travel {travel:>8}"
                f"  preempt {row['preemptions']:>2}  wall {row['wall_s']:.0f} s"
                f"  ({elapsed / 60:.1f} min){flags}",
                flush=True,
            )
    return failures


def widest_ci(out: Path, scenario: str, scales: list[float]) -> float:
    runs = load_runs(out)
    runs = runs[(runs["scenario"] == scenario) & (runs["scale"].isin(scales))]
    table = paired_table(runs)
    rows = table[(table["metric"] == "travel_s") & (table["reference"] == BASELINE.id)]
    if rows.empty:
        return float("inf")
    return float(((rows["ci_high"] - rows["ci_low"]) / 2).max())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--scenario", default="grid4x4")
    parser.add_argument("--scales", default="1.5", help="comma-separated demand multipliers")
    parser.add_argument("--seeds", default="1-10", help="e.g. 1-20 or 1,2,5")
    parser.add_argument("--arms", default="all", help="'all' or comma-separated arm ids")
    parser.add_argument("--window", type=float, default=WINDOW_S, help="s after the dispatch")
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 4))
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--keep-raw", action="store_true", help="keep SUMO logs + tripinfo")
    parser.add_argument("--rerun", action="store_true", help="repeat runs already recorded")
    parser.add_argument("--ci-target", type=float, default=None, help="s, CI half-width goal")
    parser.add_argument("--max-seeds", type=int, default=40)
    parser.add_argument("--batch", type=int, default=5, help="seeds added per CI round")
    parser.add_argument(
        "--program",
        choices=("tuned", "net"),
        default="tuned",
        help="base signal program of every arm: tuned for the demand (default) or the net's",
    )
    parser.add_argument("--report-only", action="store_true")
    args = parser.parse_args(argv)

    out: Path = args.out
    if not args.report_only:
        arms = parse_arms(args.arms)
        scales = [float(s) for s in args.scales.split(",")]
        seeds = parse_seeds(args.seeds)
        raw = out / "raw" if args.keep_raw else None
        programs = {
            scale: tuned_program(args.scenario, scale, out) if args.program == "tuned" else None
            for scale in scales
        }
        while True:
            done = set() if args.rerun else done_keys(out)
            specs = [
                RunSpec(args.scenario, scale, seed, arm, args.window, programs[scale])
                for scale in scales
                for seed in seeds
                for arm in arms
                if (args.scenario, scale, seed, arm.id) not in done
            ]
            print(f"{len(specs)} runs to do ({len(arms)} arms x {len(seeds)} seeds x "
                  f"{len(scales)} scales, {args.workers} workers)", flush=True)  # fmt: skip
            if specs and run_batch(specs, args.workers, out, raw):
                print("some runs failed; see above", file=sys.stderr)
            if args.ci_target is None:
                break
            width = widest_ci(out, args.scenario, scales)
            print(f"widest 95 % CI half-width of travel time vs baseline: {width:.1f} s "
                  f"(target {args.ci_target:g} s, {len(seeds)} seeds)", flush=True)  # fmt: skip
            if width <= args.ci_target or len(seeds) >= args.max_seeds:
                break
            seeds = seeds + list(range(max(seeds) + 1, max(seeds) + 1 + args.batch))
            args.rerun = False
    data = write_report(out)
    for experiment in data["experiments"]:
        seeds, ok = len(experiment["seeds"]), experiment["pairing_ok"]
        print(
            f"\n{experiment['scenario']} x{experiment['scale']:g}: {seeds} seeds, pairing ok: {ok}"
        )
        for arm in experiment["arms"]:
            vs = arm.get("travel_s_vs_baseline")
            diff = (
                f"{vs['mean_diff']:+.1f} s [{vs['ci'][0]:+.1f}, {vs['ci'][1]:+.1f}] p={vs['p']:.3g}"
                if vs and vs["mean_diff"] is not None
                else "baseline"
            )
            print(f"  {arm['arm']:<22} travel {arm['travel_mean']} s  vs baseline {diff}"
                  f"  valid {arm['valid']}/{arm['runs']}  safety {arm['safety']}")  # fmt: skip
    print(f"\nwritten to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

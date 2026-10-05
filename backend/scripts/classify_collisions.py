"""Which collisions in the batch results involve the ambulance?

The runs.csv collision column counts every vehicle SUMO reported in a collision after the
dispatch. This reruns each run that reported any (runs are deterministic: the same row comes
back), keeps SUMO's log, and counts the collision events that name the ambulance. Writes
experiments/summary/collisions.csv.

    .venv\\Scripts\\python.exe -m scripts.classify_collisions
"""

from __future__ import annotations

import shutil
import tempfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any

import pandas as pd

from evaluation.arms import parse_arms
from evaluation.programs import program_path
from evaluation.report import load_runs
from evaluation.runner import RunSpec, run_one
from simulation.sumo import REPO_ROOT

OUT = REPO_ROOT / "experiments"


def classify(job: tuple[str, float, int, str, float, str]) -> dict[str, Any]:
    scenario, scale, seed, arm_id, window, program = job
    (arm,) = parse_arms(arm_id)
    programs = program_path(OUT, scenario, scale) if program == "tuned" else None
    folder = Path(tempfile.mkdtemp(prefix="ef_collisions_"))
    try:
        row = run_one(RunSpec(scenario, scale, seed, arm, window, programs), folder)["row"]
        events = [
            line
            for line in (folder / "sumo.log").read_text(errors="replace").splitlines()
            if "collision" in line
        ]
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    return {
        "scenario": scenario,
        "scale": scale,
        "seed": seed,
        "arm": arm_id,
        "collisions": row["collisions"],
        "events": len(events),
        "ambulance_events": sum("'ambulance_01'" in line for line in events),
        "red_crossings": row["red_crossings"],
        "travel_s": row["travel_s"],
    }


def main() -> int:
    runs = load_runs(OUT)
    hit = runs[runs["collisions"] > 0]
    jobs = [
        (r.scenario, float(r.scale), int(r.seed), r.arm, float(r.window_s), r.signal_program)
        for r in hit.itertuples()
    ]
    print(f"{len(jobs)} of {len(runs)} runs reported collisions; rerunning them with logs")
    if not jobs:
        return 0
    with ProcessPoolExecutor(max_workers=min(14, len(jobs))) as pool:
        table = pd.DataFrame(list(pool.map(classify, jobs)))
    table = table.sort_values(["scenario", "scale", "arm", "seed"])
    original = hit.set_index(["scenario", "scale", "seed", "arm"])["collisions"]
    table["reproduced"] = [
        original.get((r.scenario, r.scale, r.seed, r.arm)) == r.collisions
        for r in table.itertuples()
    ]
    path = OUT / "summary" / "collisions.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    table.to_csv(path, index=False)
    print(table.to_string(index=False))
    print(table.groupby(["scale", "arm"])[["events", "ambulance_events"]].sum().to_string())
    print(f"written to {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

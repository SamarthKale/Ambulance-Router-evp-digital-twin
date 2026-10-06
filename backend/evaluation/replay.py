"""What the replay dashboard reads (Sprint 11): an index of every recorded run, and one run's
telemetry together with its authoritative result.

runs.csv (Sprint 9) is the authority for every number about a run. The telemetry only adds
what happened over time, and says whether its re-run matched that row. A run without telemetry
is still listed (its aggregate result is real); the dashboard says the playback is not recorded.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

import pandas as pd

from evaluation.arms import ALL_ARMS
from evaluation.report import load_runs
from evaluation.telemetry import read_telemetry, telemetry_path

KEY = re.compile(r"^(?P<scenario>[A-Za-z0-9]+)_x(?P<scale>\d+(?:\.\d+)?)_seed(?P<seed>\d{3})$")
ARMS = {arm.id: arm for arm in ALL_ARMS}
INDEX_FILE = "index.json"

_INT = ("stops", "red_stops", "red_crossings", "preemptions", "route_changes", "violations",
        "collisions", "emergency_brakings", "teleports")  # fmt: skip
_FLOAT = ("travel_s", "wait_s", "approach_clear_s", "queue_mean", "bg_time_loss_s", "cycle_s",
          "dispatch_s", "trip_m")  # fmt: skip


def run_key(scenario: str, scale: float, seed: int) -> str:
    return f"{scenario}_x{scale:g}_seed{seed:03d}"


def valid_run(arm: str, key: str) -> bool:
    return arm in ARMS and KEY.match(key) is not None


def _number(value: Any) -> float | None:
    if value is None:
        return None
    number = float(value)
    return None if math.isnan(number) else number


def classification(out: Path) -> dict[tuple[str, float, int, str], int]:
    """Collision events that named the ambulance, per run, from summary/collisions.csv
    (scripts.classify_collisions re-ran every run that had a collision). Empty until it ran."""
    path = out / "summary" / "collisions.csv"
    if not path.exists():
        return {}
    table = pd.read_csv(path)
    table = table[table["reproduced"].astype(bool)]  # a run that did not reproduce says nothing
    return {
        (str(r.scenario), float(r.scale), int(r.seed), str(r.arm)): int(r.ambulance_events)
        for r in table.itertuples(index=False)
    }


def summary(
    row: pd.Series, classified: dict[tuple[str, float, int, str], int] | None = None
) -> dict[str, Any]:
    """The authoritative result of one run, from its runs.csv row (blank cells are None).

    ambulance_collisions: 0 when SUMO reported no collision in the run; else the classified
    count of events that named the ambulance; None when the run was not classified."""
    out: dict[str, Any] = {
        "origin": str(row["origin"]),
        "destination": str(row["destination"]),
        "arrived": bool(row["arrived"]),
        "valid": bool(row["valid"]),
        "signal_program": str(row["signal_program"]),
    }
    for name in _FLOAT:
        out[name] = _number(row.get(name))
    for name in _INT:
        number = _number(row.get(name))
        out[name] = None if number is None else int(number)
    key = (str(row["scenario"]), float(row["scale"]), int(row["seed"]), str(row["arm"]))
    if out["collisions"] == 0:
        out["ambulance_collisions"] = 0
    else:
        out["ambulance_collisions"] = (classified or {}).get(key)
    return out


def _telemetry_index(out: Path) -> dict[str, Any]:
    path = out / "telemetry" / INDEX_FILE
    if not path.exists():
        return {}
    try:
        runs: dict[str, Any] = json.loads(path.read_text(encoding="utf-8")).get("runs", {})
    except (OSError, ValueError):
        return {}
    return runs


def _file_meta(out: Path, arm: str, key: str, stored: dict[str, Any]) -> dict[str, Any] | None:
    """What the index says about a run's telemetry file: from the index written by
    scripts.record_telemetry, or read from the file itself when the index lacks it."""
    path = telemetry_path(out / "telemetry", arm, key)
    if not path.is_file():
        return None
    meta = stored.get(f"{arm}/{key}")
    if meta is not None:
        return dict(meta)
    try:
        data = read_telemetry(path)
        verification = data["verification"]
        return {
            "matches_recorded": verification["matches_recorded"],
            "traffic": data.get("traffic") is not None,
            "differences": verification["differences"],
        }
    except (OSError, ValueError, KeyError):
        return None  # unreadable: listed without playback


def build_index(out: Path) -> dict[str, Any]:
    """Every recorded run (runs.csv) and whether its playback telemetry exists."""
    recorded = load_runs(out)
    if recorded.empty:
        return {"available": False, "note": "no experiment runs yet", "runs": []}
    stored = _telemetry_index(out)
    classified = classification(out)
    runs = []
    for _, row in recorded.sort_values(["scenario", "scale", "seed", "arm"]).iterrows():
        arm = ARMS[str(row["arm"])]
        key = run_key(str(row["scenario"]), float(row["scale"]), int(row["seed"]))
        meta = _file_meta(out, arm.id, key, stored)
        has = meta is not None
        runs.append(
            {
                "id": f"{arm.id}/{key}",
                "scenario": str(row["scenario"]),
                "scale": float(row["scale"]),
                "seed": int(row["seed"]),
                "arm": arm.id,
                "strategy": arm.signals,
                "routing": arm.routing,
                "summary": summary(row, classified),
                "telemetry": has,
                "matches_recorded": None if meta is None else bool(meta["matches_recorded"]),
                "traffic": meta is not None and bool(meta["traffic"]),
                "differences": [] if meta is None else list(meta["differences"]),
            }
        )
    return {"available": True, "note": "", "runs": runs}


def load_run(out: Path, arm: str, key: str) -> dict[str, Any] | None:
    """One run's telemetry (as stored) plus its identity and authoritative summary, or None
    when no telemetry was recorded for it."""
    path = telemetry_path(out / "telemetry", arm, key)
    if not valid_run(arm, key) or not path.is_file():
        return None
    match = KEY.match(key)
    assert match is not None
    scenario, scale, seed = match["scenario"], float(match["scale"]), int(match["seed"])
    data = read_telemetry(path)
    recorded = load_runs(out)
    row = recorded[
        (recorded["scenario"] == scenario)
        & (recorded["scale"] == scale)
        & (recorded["seed"] == seed)
        & (recorded["arm"] == arm)
    ]
    return {
        **data,
        "id": f"{arm}/{key}",
        "scenario": scenario,
        "scale": scale,
        "seed": seed,
        "arm": arm,
        "strategy": ARMS[arm].signals,
        "routing": ARMS[arm].routing,
        "summary": None if row.empty else summary(row.iloc[0], classification(out)),
    }

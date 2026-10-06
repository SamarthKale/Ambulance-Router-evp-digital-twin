"""One experiment run: a seeded mission in one arm, headless and unpaced (CLAUDE.md section 14).

The simulation runs from t = 0 to the mission's dispatch time with no ambulance (identical in
every arm of a seed: checked by a traffic fingerprint), dispatches the autopilot ambulance,
and runs a fixed window after the dispatch, so background-traffic metrics cover the same
period, recovery included, in every arm.
"""

from __future__ import annotations

import functools
import hashlib
import json
import platform
import shutil
import subprocess
import time
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ai.routing import RoadGraph
from evaluation.arms import Arm
from evaluation.metrics import MissionMetrics, parse_log, parse_tripinfo
from evaluation.missions import MissionSpec, draw_mission
from evaluation.telemetry import TelemetryRecorder
from simulation.engine import SimulationEngine, SpawnAmbulance
from simulation.network import RoadNetwork
from simulation.sumo import REPO_ROOT, SCENARIOS_DIR, SumoConfig, find_sumo_binary
from simulation.vehicle import AMBULANCE_TYPE

WINDOW_S = 600.0  # after the dispatch: the mission plus signal recovery, same in every arm
RED_TYPE = "ambulance_red"  # off_realistic: crosses red lights...
RED_AFTER_S = 300.0  # ...however long they have been red (SUMO jmDriveAfterRedTime)
RED_SPEED = 5.56  # ...at 20 km/h at most (jmDriveRedSpeed): cautiously


@dataclass(frozen=True)
class RunSpec:
    scenario: str
    scale: float
    seed: int
    arm: Arm
    window_s: float = WINDOW_S
    # The base signal program every arm shares (evaluation/programs.py); None = the net's own.
    signal_programs: Path | None = None

    @property
    def key(self) -> str:
        return f"{self.scenario}_x{self.scale:g}_seed{self.seed:03d}"


@functools.cache
def _network(scenario: str) -> tuple[RoadNetwork, RoadGraph]:
    network = RoadNetwork(scenario)
    return network, network.road_graph()


def mission_for(scenario: str, seed: int) -> MissionSpec:
    network, graph = _network(scenario)
    return draw_mission(network, graph, seed)


def approach_edges(scenario: str) -> frozenset[str]:
    """Roads that end at a signal: where queues are measured."""
    _, graph = _network(scenario)
    return frozenset(
        e.id for e in graph.edges.values() if any(m.tls is not None for m in e.movements)
    )


def write_red_vtype(scenario: str, path: Path) -> Path:
    """The scenario's ambulance vType, copied as RED_TYPE with SUMO's red-crossing junction
    model parameters (TraCI can't set those on a vehicle)."""
    routes = ET.parse(SCENARIOS_DIR / scenario / "routes.rou.xml").getroot()
    base = next(v for v in routes.iter("vType") if v.get("id") == AMBULANCE_TYPE)
    vtype = ET.Element("vType", dict(base.attrib))
    vtype.set("id", RED_TYPE)
    vtype.set("jmDriveAfterRedTime", f"{RED_AFTER_S:g}")
    vtype.set("jmDriveRedSpeed", f"{RED_SPEED:g}")
    root = ET.Element("additional")
    root.append(vtype)
    path.parent.mkdir(parents=True, exist_ok=True)
    ET.ElementTree(root).write(path, encoding="unicode")
    return path


def run_one(
    spec: RunSpec, work_dir: Path, recorder: TelemetryRecorder | None = None
) -> dict[str, Any]:
    """Run one arm on one seed; returns the CSV row and its run manifest. A recorder only
    watches the states (it never changes the run) and its telemetry is returned too."""
    started = time.perf_counter()
    mission = mission_for(spec.scenario, spec.seed)
    work_dir.mkdir(parents=True, exist_ok=True)
    tripinfo, log = work_dir / "tripinfo.xml", work_dir / "sumo.log"
    red = work_dir / "red.add.xml"
    config = SumoConfig(
        scenario=spec.scenario,
        seed=spec.seed,
        scale=spec.scale,
        log_path=log,
        additional_files=(write_red_vtype(spec.scenario, red),) if spec.arm.crosses_red else (),
        signal_programs=spec.signal_programs,
        extra_args=(
            "--tripinfo-output", str(tripinfo), "--tripinfo-output.write-unfinished", "true"
        ),  # fmt: skip
    )
    engine = SimulationEngine(
        config,
        realtime=False,
        deadman_s=None,
        mode=spec.arm.mode,
        routing=spec.arm.routing,
        control="autopilot",
        warmup_s=mission.dispatch_s,
        mission=mission.mission,
        ambulance_type=RED_TYPE if spec.arm.crosses_red else AMBULANCE_TYPE,
    )
    metrics = MissionMetrics(mission.dispatch_s, approach_edges(spec.scenario))
    engine.open()
    try:
        engine.submit(SpawnAmbulance())
        end = mission.dispatch_s + spec.window_s - 1e-6
        while True:
            state = engine.tick()
            if recorder is not None:
                recorder.observe(state)
            metrics.observe(state)
            if state.snapshot.time >= end:
                break
    finally:
        engine.close()
    row: dict[str, Any] = {
        "scenario": spec.scenario,
        "scale": spec.scale,
        "seed": spec.seed,
        "arm": spec.arm.id,
        "signals": spec.arm.signals,
        "routing": spec.arm.routing,
        "origin": mission.origin,
        "destination": mission.destination,
        "dispatch_s": mission.dispatch_s,
        "trip_m": mission.distance_m,
        "window_s": spec.window_s,
        "signal_program": "tuned" if spec.signal_programs else "net",
        "cycle_s": round(_mean_cycle(engine), 1),
        **metrics.result(),
        **parse_tripinfo(tripinfo),
        **parse_log(log, since=mission.dispatch_s),
    }
    row["valid"] = bool(row["arrived"]) and row["teleports"] == 0
    row["wall_s"] = round(time.perf_counter() - started, 1)
    result: dict[str, Any] = {"row": row, "manifest": manifest(spec, mission, config)}
    if recorder is not None:
        result["telemetry"] = recorder.result()
    return result


def _mean_cycle(engine: SimulationEngine) -> float:
    cycles = [sum(d for _, d in table.phases) for table in engine.tables.values()]
    return sum(cycles) / len(cycles)


# ---- run manifest ------------------------------------------------------------------------
@functools.cache
def sumo_version() -> str:
    out = subprocess.run(
        [str(find_sumo_binary()), "--version"], capture_output=True, text=True, check=False
    )
    return out.stdout.splitlines()[0].strip() if out.stdout else "unknown"


@functools.cache
def git_state() -> tuple[str, bool]:
    """(commit SHA, uncommitted changes outside experiments/)."""
    git = shutil.which("git")
    if git is None:
        return "unknown", False
    sha = subprocess.run(
        [git, "rev-parse", "HEAD"], capture_output=True, text=True, cwd=REPO_ROOT, check=False
    ).stdout.strip()
    status = subprocess.run(
        [git, "status", "--porcelain", "--", ".", ":!experiments"],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        check=False,
    ).stdout
    return sha or "unknown", bool(status.strip())


def config_hash(spec: RunSpec, config: SumoConfig) -> str:
    """Everything that determines the run: scenario files, SUMO options, arm and window."""
    digest = hashlib.sha256()
    folder = SCENARIOS_DIR / spec.scenario
    for name in ("simulation.sumocfg", "network.net.xml", "routes.rou.xml", "scenario.json"):
        digest.update((folder / name).read_bytes())
    if spec.signal_programs is not None:
        digest.update(spec.signal_programs.read_bytes())
    options = [o for o in config.command(Path("sumo"), 0) if "\\" not in o and "/" not in o]
    params = {"options": options, "arm": spec.arm.id, "window_s": spec.window_s}
    digest.update(json.dumps(params, sort_keys=True).encode())
    return digest.hexdigest()[:16]


def manifest(spec: RunSpec, mission: MissionSpec, config: SumoConfig) -> dict[str, Any]:
    sha, dirty = git_state()
    return {
        "run": spec.key,
        "arm": spec.arm.id,
        "scenario": spec.scenario,
        "scale": spec.scale,
        "seed": spec.seed,
        "window_s": spec.window_s,
        "signal_program": spec.signal_programs.name if spec.signal_programs else "network.net.xml",
        "mission": asdict(mission),
        "control": "autopilot",
        "sumo_version": sumo_version(),
        "git_sha": sha,
        "git_dirty": dirty,
        "config_hash": config_hash(spec, config),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }

"""OFF vs BASIC vs COORD smoke comparison on ONE seed. Not the evaluation (that is Sprint 9).

Same scripted mission in both modes: depot -> straight at A0 -> left at B0 -> right at B1
-> hospital, full throttle. Background delay is measured over the same fixed window in
both runs so the faster run is not flattered by a shorter window.

    .venv\\Scripts\\python.exe -m scripts.smoke_compare [--seed 42] [--scale 1.0]
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from simulation.engine import Drive, Mode, SimulationEngine, SpawnAmbulance, Turn
from simulation.sumo import STEP_LENGTH, SumoConfig
from simulation.vehicle import AMBULANCE_ID

TURNS = {"A0_B0": "left", "B0_B1": "right"}  # requested when the ambulance enters the road
HORIZON_S = 300.0


@dataclass(frozen=True)
class MissionResult:
    mode: str
    seed: int
    mission_time: float | None  # s from dispatch to parked at the hospital
    stopped_s: float  # ambulance standing still while en route
    stops: int  # times it came to a standstill en route
    preemptions: int
    queues_cleared: int
    violations: int
    collisions: int
    background_halted_veh_s: float  # other vehicles standing still, summed, over HORIZON_S


def run_mission(mode: Mode, seed: int = 42, scale: float = 1.0) -> MissionResult:
    log_path = Path(tempfile.gettempdir()) / f"ef_smoke_{mode}_{seed}.log"
    engine = SimulationEngine(
        SumoConfig(seed=seed, scale=scale, log_path=log_path),
        realtime=False,
        deadman_s=None,
        mode=mode,
    )
    engine.open()
    try:
        engine.submit(SpawnAmbulance())
        engine.submit(Drive(throttle=1, brake=0))
        asked: set[str] = set()
        mission_time = None
        stopped_s = background = 0.0
        stops = 0
        moving = False
        state = engine.tick()
        while state.snapshot.time < HORIZON_S:
            state = engine.tick()
            vehicles = state.snapshot.vehicles
            background += STEP_LENGTH * sum(v.speed < 0.1 for v in vehicles if v.id != AMBULANCE_ID)
            ambulance = state.snapshot.vehicle(AMBULANCE_ID)
            if ambulance is None or state.ambulance.status != "driving":
                if state.ambulance.status == "arrived" and mission_time is None:
                    mission_time = state.ambulance.mission_time
                continue
            if ambulance.edge in TURNS and ambulance.edge not in asked:
                engine.submit(Turn(TURNS[ambulance.edge]))  # type: ignore[arg-type]
                asked.add(ambulance.edge)
            if ambulance.speed < 0.1:
                if moving:
                    stops += 1
                if moving or stops:
                    stopped_s += STEP_LENGTH
                moving = False
            elif ambulance.speed > 1.0:
                moving = True
        return MissionResult(
            mode=mode,
            seed=seed,
            mission_time=mission_time,
            stopped_s=round(stopped_s, 1),
            stops=stops,
            preemptions=state.safety.signals_preempted,
            queues_cleared=state.queues_cleared,
            violations=state.safety.violations,
            collisions=state.safety.collisions,
            background_halted_veh_s=round(background, 1),
        )
    finally:
        engine.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="OFF vs BASIC vs COORD on one seed (smoke)")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--scale", type=float, default=1.0)
    args = parser.parse_args(argv)
    modes: tuple[Mode, ...] = ("OFF", "BASIC", "COORD")
    results = [run_mission(mode, args.seed, args.scale) for mode in modes]
    print(f"Smoke comparison, seed {args.seed}, demand x{args.scale} (ONE seed: not evidence)")
    header = (
        f"{'mode':6} {'mission s':>9} {'stopped s':>9} {'stops':>5} {'preempt':>7} "
        f"{'q cleared':>9} {'violations':>10} {'collisions':>10} {'bg halted veh*s':>15}"
    )
    print(header)
    for r in results:
        mission = f"{r.mission_time:.1f}" if r.mission_time is not None else "n/a"
        print(
            f"{r.mode:6} {mission:>9} {r.stopped_s:>9.1f} {r.stops:>5} {r.preemptions:>7} "
            f"{r.queues_cleared:>9} {r.violations:>10} {r.collisions:>10} "
            f"{r.background_halted_veh_s:>15.1f}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())

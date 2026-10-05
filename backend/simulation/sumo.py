"""SUMO process and TraCI connection lifecycle (headless by default).

Only the simulation/ layer imports traci (CLAUDE.md section 6). This module owns the
SUMO subprocess so it can guarantee shutdown: close() asks TraCI to close, waits,
then kills, and it also runs from __exit__ and atexit. Each instance uses its own
unlabeled TraCI connection object, never the global traci module state, so several
simulations can run side by side (batch experiments, ghost run).

CLI (from backend/):
    .venv\\Scripts\\python.exe -m simulation.sumo --steps 600 --print-every 50
"""

from __future__ import annotations

import argparse
import atexit
import math
import os
import shutil
import subprocess
import sys
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from types import TracebackType
from typing import IO, Any

import sumolib
import traci
from dotenv import load_dotenv
from traci import constants as tc
from traci.connection import Connection
from traci.exceptions import FatalTraCIError, TraCIException

REPO_ROOT = Path(__file__).resolve().parents[2]
SCENARIOS_DIR = REPO_ROOT / "scenarios"
STEP_LENGTH = 0.1  # s, fixed for every run (CLAUDE.md section 6)
CONNECT_TIMEOUT_S = 10.0
SHUTDOWN_TIMEOUT_S = 5.0
_TLS_VARS = (
    tc.TL_RED_YELLOW_GREEN_STATE,
    tc.TL_CURRENT_PHASE,
    tc.TL_CURRENT_PROGRAM,
    tc.TL_NEXT_SWITCH,
)
_SIMULATION_VARS = (tc.VAR_TIME, tc.VAR_COLLIDING_VEHICLES_NUMBER)
# Live edge conditions for routing: one subscription per road, read with every step.
_EDGE_VARS = (
    tc.LAST_STEP_MEAN_SPEED,
    tc.LAST_STEP_VEHICLE_HALTING_NUMBER,
    tc.LAST_STEP_VEHICLE_NUMBER,
)
_VEHICLE_VARS = (
    tc.VAR_POSITION,
    tc.VAR_ANGLE,
    tc.VAR_SPEED,
    tc.VAR_TYPE,
    tc.VAR_ROAD_ID,
    tc.VAR_LANE_INDEX,
    tc.VAR_LENGTH,
)


class SumoNotFoundError(RuntimeError):
    """The SUMO binary could not be located."""


class SumoStartError(RuntimeError):
    """SUMO exited, or never accepted the TraCI connection."""


def find_sumo_binary(name: str = "sumo") -> Path:
    """Resolve a SUMO executable via SUMO_HOME (system or repo .env), then PATH."""
    load_dotenv(REPO_ROOT / ".env")  # does not override variables already set
    candidate = sumolib.checkBinary(name)  # SUMO_HOME/bin/<name>, else the bare name
    resolved = candidate if os.path.isfile(candidate) else shutil.which(candidate)
    if resolved is None:
        raise SumoNotFoundError(
            f"Could not find '{name}'. Set SUMO_HOME to your SUMO install folder "
            f"(system-wide or in {REPO_ROOT / '.env'}), or put its bin folder on PATH."
        )
    return Path(resolved)


@dataclass(frozen=True)
class SumoConfig:
    scenario: str = "grid2x2"  # folder under scenarios/
    seed: int = 42
    scale: float = 1.0  # demand multiplier (1.5 = heavy-traffic demo)
    gui: bool = False  # sumo-gui is for debugging only, never the product UI
    log_path: Path = REPO_ROOT / "logs" / "sumo.log"
    # Route file in the scenario folder that replaces the sumocfg's. None = the sumocfg's
    # 1-hour experiment demand; the live server uses "routes.live.rou.xml" (24 h flows).
    routes: str | None = None
    additional_files: tuple[Path, ...] = ()  # e.g. extra vTypes (batch experiments)
    # Normal signal programs replacing the net's (an additional file of tlLogic elements,
    # e.g. tuned for the demand by tlsCycleAdaptation.py). SUMO activates the loaded program;
    # load_signal_tables(net_path, signal_programs) gives the controller the same one.
    signal_programs: Path | None = None
    extra_args: tuple[str, ...] = ()

    @property
    def sumocfg(self) -> Path:
        return SCENARIOS_DIR / self.scenario / "simulation.sumocfg"

    @property
    def net_path(self) -> Path:
        return SCENARIOS_DIR / self.scenario / "network.net.xml"

    def command(self, binary: Path, port: int) -> list[str]:
        # fmt: off
        cmd = [
            str(binary),
            "-c", str(self.sumocfg),
            "--remote-port", str(port),
            "--seed", str(self.seed),
            "--scale", str(self.scale),
            "--step-length", str(STEP_LENGTH),
        ]
        # fmt: on
        if self.routes is not None:
            cmd += ["--route-files", str(SCENARIOS_DIR / self.scenario / self.routes)]
        additional = [*self.additional_files]
        if self.signal_programs is not None:
            additional.append(self.signal_programs)
        if additional:
            cmd += ["--additional-files", ",".join(str(p) for p in additional)]
        if self.gui:
            cmd += ["--start", "--quit-on-end"]
        return cmd + list(self.extra_args)


@dataclass(frozen=True)
class SignalState:
    tls_id: str
    state: str  # one SUMO signal char per controlled link (G g y r ...)
    phase: int
    program: str
    next_switch: float = 0.0  # simulation time at which the current phase ends


@dataclass(frozen=True)
class EdgeState:
    mean_speed: float  # m/s over the vehicles on it (SUMO reports the limit when empty)
    halting: int  # vehicles below 0.1 m/s
    vehicles: int


@dataclass(frozen=True)
class VehicleState:
    id: str
    type: str  # vType id, doubles as the 3D asset key
    x: float  # m, vehicle centre (SUMO itself reports the front bumper)
    y: float
    angle: float  # deg clockwise from north
    speed: float  # m/s
    edge: str  # ":<junction>_<n>" while crossing a junction
    lane: int  # 0 = curb lane


@dataclass(frozen=True)
class Snapshot:
    time: float  # s
    signals: tuple[SignalState, ...]
    vehicles: tuple[VehicleState, ...]
    collisions: int = 0  # vehicles involved in a collision during the last step (SUMO)
    edges: Mapping[str, EdgeState] = field(default_factory=dict)  # roads only, not junctions

    @property
    def vehicle_count(self) -> int:
        return len(self.vehicles)

    def vehicle(self, vehicle_id: str) -> VehicleState | None:
        return next((v for v in self.vehicles if v.id == vehicle_id), None)


class SumoSimulation:
    """One SUMO instance driven over TraCI. Use as a context manager."""

    def __init__(self, config: SumoConfig | None = None) -> None:
        self.config = config or SumoConfig()
        self.sumo_version = ""
        self.exit_code: int | None = None
        self._proc: subprocess.Popen[bytes] | None = None
        self._conn: Connection | None = None
        self._log: IO[bytes] | None = None
        self._tls_ids: tuple[str, ...] = ()
        self._edge_ids: tuple[str, ...] = ()
        self._context_anchor = ""

    # ---- lifecycle -------------------------------------------------------
    def start(self) -> None:
        if self._proc is not None:
            raise RuntimeError("simulation already started")
        if not self.config.sumocfg.is_file():
            raise FileNotFoundError(f"Scenario config not found: {self.config.sumocfg}")
        binary = find_sumo_binary("sumo-gui" if self.config.gui else "sumo")
        port = sumolib.miscutils.getFreeSocketPort()
        self.config.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._log = open(self.config.log_path, "wb")
        self._proc = subprocess.Popen(
            self.config.command(binary, port), stdout=self._log, stderr=subprocess.STDOUT
        )
        atexit.register(self.close)
        try:
            self._conn = self._connect(port)
            self.sumo_version = self._conn.getVersion()[1]
            self._tls_ids = tuple(sorted(self._conn.trafficlight.getIDList()))
            for tls_id in self._tls_ids:
                self._conn.trafficlight.subscribe(tls_id, _TLS_VARS)
            self._edge_ids = tuple(
                e for e in sorted(self._conn.edge.getIDList()) if not e.startswith(":")
            )
            for edge_id in self._edge_ids:
                self._conn.edge.subscribe(edge_id, _EDGE_VARS)
            self._subscribe_all_vehicles(self._conn)
            self._conn.simulation.subscribe(_SIMULATION_VARS)
        except BaseException:
            self.close()
            raise

    def _connect(self, port: int) -> Connection:
        deadline = time.monotonic() + CONNECT_TIMEOUT_S
        while True:
            try:
                # numRetries=0: we retry here, quietly, with our own timeout.
                return traci.connect(port=port, numRetries=0, proc=self._proc)
            except TraCIException as exc:  # raised when SUMO already exited
                raise SumoStartError(f"SUMO exited during startup:\n{self._log_tail()}") from exc
            except FatalTraCIError as exc:
                if time.monotonic() > deadline:
                    raise SumoStartError(
                        f"SUMO did not accept TraCI on port {port} within "
                        f"{CONNECT_TIMEOUT_S:g} s:\n{self._log_tail()}"
                    ) from exc
                time.sleep(0.05)

    def _subscribe_all_vehicles(self, conn: Connection) -> None:
        """One context subscription around the central junction covers the whole map, so
        every vehicle's state arrives with each simulationStep() reply (no per-vehicle calls)."""
        (xmin, ymin), (xmax, ymax) = conn.simulation.getNetBoundary()
        cx, cy = (xmin + xmax) / 2, (ymin + ymax) / 2
        junctions = [j for j in conn.junction.getIDList() if not j.startswith(":")]

        def dist_to_centre(junction_id: str) -> float:
            x, y = conn.junction.getPosition(junction_id)
            return math.hypot(x - cx, y - cy)

        self._context_anchor = min(junctions, key=dist_to_centre)
        radius = math.hypot(xmax - xmin, ymax - ymin)
        conn.junction.subscribeContext(
            self._context_anchor, tc.CMD_GET_VEHICLE_VARIABLE, radius, _VEHICLE_VARS
        )

    def close(self) -> None:
        """Idempotent. TraCI close, then wait, then kill: no sumo process outlives this."""
        atexit.unregister(self.close)
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.close(wait=False)
            except (TraCIException, FatalTraCIError, OSError):
                pass  # SUMO already gone; the process is still reaped below
        proc, self._proc = self._proc, None
        if proc is not None:
            try:
                proc.wait(timeout=SHUTDOWN_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=SHUTDOWN_TIMEOUT_S)
            self.exit_code = proc.returncode
        if self._log is not None:
            self._log.close()
            self._log = None

    def __enter__(self) -> SumoSimulation:
        self.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()

    # ---- state -------------------------------------------------------------
    @property
    def pid(self) -> int | None:
        return self._proc.pid if self._proc is not None else None

    @property
    def tls_ids(self) -> tuple[str, ...]:
        return self._tls_ids

    @property
    def connection(self) -> Connection:
        """For other modules of the simulation layer only (CLAUDE.md section 6)."""
        return self._require_conn()

    def step(self) -> Snapshot:
        """Advance one STEP_LENGTH and return the new state."""
        self._require_conn().simulationStep()
        return self.snapshot()

    def snapshot(self) -> Snapshot:
        conn = self._require_conn()
        results = conn.trafficlight.getAllSubscriptionResults()
        signals = tuple(
            SignalState(
                tls_id=tls_id,
                state=results[tls_id][tc.TL_RED_YELLOW_GREEN_STATE],
                phase=results[tls_id][tc.TL_CURRENT_PHASE],
                program=results[tls_id][tc.TL_CURRENT_PROGRAM],
                next_switch=float(results[tls_id][tc.TL_NEXT_SWITCH]),
            )
            for tls_id in self._tls_ids
        )
        context = conn.junction.getContextSubscriptionResults(self._context_anchor) or {}
        vehicles = tuple(_vehicle_state(vid, context[vid]) for vid in sorted(context))
        sim_vars = conn.simulation.getSubscriptionResults()
        edge_vars = conn.edge.getAllSubscriptionResults()
        edges = {
            e: EdgeState(
                mean_speed=float(v[tc.LAST_STEP_MEAN_SPEED]),
                halting=int(v[tc.LAST_STEP_VEHICLE_HALTING_NUMBER]),
                vehicles=int(v[tc.LAST_STEP_VEHICLE_NUMBER]),
            )
            for e, v in edge_vars.items()
        }
        return Snapshot(
            time=float(sim_vars[tc.VAR_TIME]),
            signals=signals,
            vehicles=vehicles,
            collisions=int(sim_vars[tc.VAR_COLLIDING_VEHICLES_NUMBER]),
            edges=edges,
        )

    def signal_program(self, tls_id: str) -> tuple[tuple[str, float], ...]:
        """(state, duration s) for each phase of the signal's active program."""
        conn = self._require_conn()
        active = conn.trafficlight.getProgram(tls_id)
        logic = next(
            lg for lg in conn.trafficlight.getAllProgramLogics(tls_id) if lg.programID == active
        )
        return tuple((p.state, float(p.duration)) for p in logic.phases)

    def _require_conn(self) -> Connection:
        if self._conn is None:
            raise RuntimeError("simulation is not running; call start() or use 'with'")
        return self._conn

    def _log_tail(self, lines: int = 20) -> str:
        if self._log is not None:
            self._log.flush()
        try:
            text = self.config.log_path.read_text(errors="replace")
        except OSError:
            return "(no SUMO log)"
        return "\n".join(text.splitlines()[-lines:]) or "(SUMO log is empty)"


def _vehicle_state(vehicle_id: str, values: Mapping[int, Any]) -> VehicleState:
    """TraCI subscription values (untyped) -> VehicleState, front bumper -> centre."""
    x, y = values[tc.VAR_POSITION]
    angle = float(values[tc.VAR_ANGLE])
    half = float(values[tc.VAR_LENGTH]) / 2
    heading = math.radians(angle)  # SUMO: clockwise from north, so direction = (sin, cos)
    return VehicleState(
        id=vehicle_id,
        type=str(values[tc.VAR_TYPE]),
        x=x - half * math.sin(heading),
        y=y - half * math.cos(heading),
        angle=angle,
        speed=float(values[tc.VAR_SPEED]),
        edge=str(values[tc.VAR_ROAD_ID]),
        lane=int(values[tc.VAR_LANE_INDEX]),
    )


def format_snapshot(snap: Snapshot) -> str:
    signals = "  ".join(f"{s.tls_id}={s.state}(p{s.phase})" for s in snap.signals)
    return f"t={snap.time:7.1f}s  vehicles={snap.vehicle_count:4d}  {signals}"


def main(argv: list[str] | None = None) -> int:
    load_dotenv(REPO_ROOT / ".env")
    parser = argparse.ArgumentParser(
        description="Run SUMO via TraCI and print vehicle count and signal states."
    )
    parser.add_argument("--scenario", default=os.environ.get("EF_SCENARIO", "grid2x2"))
    parser.add_argument("--seed", type=int, default=int(os.environ.get("EF_SEED", "42")))
    parser.add_argument("--scale", type=float, default=1.0, help="demand multiplier")
    parser.add_argument("--steps", type=int, default=600, help=f"{STEP_LENGTH} s per step")
    parser.add_argument("--print-every", type=int, default=50)
    parser.add_argument("--gui", action="store_true", help="sumo-gui, for debugging only")
    args = parser.parse_args(argv)

    config = SumoConfig(scenario=args.scenario, seed=args.seed, scale=args.scale, gui=args.gui)
    with SumoSimulation(config) as sim:
        print(
            f"{sim.sumo_version} | scenario {config.scenario} | seed {config.seed} | "
            f"scale {config.scale} | step {STEP_LENGTH} s | sumo pid {sim.pid}"
        )
        for i in range(1, args.steps + 1):
            snap = sim.step()
            if i % args.print_every == 0 or i == args.steps:
                print(format_snapshot(snap))
    print(f"SUMO closed (exit code {sim.exit_code}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

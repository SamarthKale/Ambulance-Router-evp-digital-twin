"""Safety controller (CLAUDE.md sections 7-8): the decision logic proposes, this disposes.

Pure Python, no TraCI. It turns preemption requests into planned signal sequences, checks
every plan against the safety rules before accepting it, and emits actuations one step at
a time on the simulation clock. simulation/traffic_lights.py executes them.

Per junction:  program -> clearing -> preempted -> recovering -> program
  clearing   : yellow (4 s) for links losing green, then all-red (2 s), then the
               approach-exclusive green for the emergency vehicle
  preempted  : holds that green until released or for at most 40 s since acceptance
  recovering : yellow (4 s) -> all-red (2 s) -> normal program at the other direction's green
After recovery the cross traffic keeps its green for at least 10 s before a new preemption.
"""

from __future__ import annotations

import logging
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal

from safety.invariants import ALL_RED_MIN_S, YELLOW_MIN_S, SignalChecker
from safety.signal_table import GREEN, SignalTable

log = logging.getLogger(__name__)

YELLOW_S = YELLOW_MIN_S
ALL_RED_S = ALL_RED_MIN_S
MAX_PREEMPT_S = 40.0  # since acceptance; then recover
MIN_CROSS_GREEN_S = 10.0  # after recovery, before the junction accepts a new preemption
EMERGENCY_CLASS = "emergency"
EVENT_HISTORY = 200
_EPS = 1e-6

Stage = Literal["program", "clearing", "preempted", "recovering"]


@dataclass(frozen=True)
class SetSignalState:
    tls_id: str
    state: str


@dataclass(frozen=True)
class ResumeProgram:
    tls_id: str
    program_id: str
    phase: int


Actuation = SetSignalState | ResumeProgram


@dataclass(frozen=True)
class Decision:
    accepted: bool
    reason: str
    code: str = ""  # short machine-readable reason, used to avoid repeating log lines


@dataclass(frozen=True)
class SafetyEvent:
    time: float
    junction: str
    vehicle: str | None
    action: str  # preempt, green, release, timeout, recover, resume, fail_safe
    accepted: bool
    reason: str


class UnsafePlanError(RuntimeError):
    """The controller produced a plan that breaks a safety rule (a bug, never expected)."""


@dataclass
class _Step:
    action: Actuation
    state: str  # signal state shown once the action is applied
    hold_s: float  # minimum time before the next step; 0 for the last step


@dataclass
class _Junction:
    table: SignalTable
    stage: Stage = "program"
    vehicle: str | None = None
    approach: str | None = None
    accepted_at: float = 0.0
    plan: deque[_Step] = field(default_factory=deque)
    step_started_at: float | None = None
    hold_s: float = 0.0
    applied: str | None = None  # last state this controller applied
    resumed_at: float | None = None
    last_reject: str = ""


def transition(current: str, target: str) -> list[tuple[str, float]]:
    """States (with minimum durations) to go from `current` to `target` safely.

    Links green in both keep their signal; links losing green show yellow for 4 s (links
    already yellow restart a full 4 s); then an all-red of 2 s before anything gains green.
    """
    keep = {
        i for i, (a, b) in enumerate(zip(current, target, strict=True)) if a in GREEN and b in GREEN
    }
    clear = {
        i
        for i, (a, b) in enumerate(zip(current, target, strict=True))
        if (a in GREEN and b not in GREEN) or a == "y"
    }
    gains = any(
        (b in GREEN and a not in GREEN) or (a == "g" and b == "G")
        for a, b in zip(current, target, strict=True)
    )
    steps: list[tuple[str, float]] = []
    if clear:
        yellow = "".join(
            "y" if i in clear else (c if i in keep else "r") for i, c in enumerate(current)
        )
        steps.append((yellow, YELLOW_S))
    if clear or gains:
        all_red = "".join(c if i in keep else "r" for i, c in enumerate(current))
        steps.append((all_red, ALL_RED_S))
    steps.append((target, 0.0))
    return steps


class SafetyController:
    def __init__(self, tables: Mapping[str, SignalTable]) -> None:
        self._junctions = {tls: _Junction(table) for tls, table in tables.items()}
        self.events: deque[SafetyEvent] = deque(maxlen=EVENT_HISTORY)
        self.signals_preempted = 0

    # ---- queries -------------------------------------------------------------------
    def stage(self, tls_id: str) -> Stage:
        return self._junctions[tls_id].stage

    def stages(self) -> dict[str, Stage]:
        return {tls: j.stage for tls, j in self._junctions.items()}

    def held_for(self, vehicle_id: str) -> list[str]:
        """Junctions clearing or preempted for this vehicle."""
        return [
            tls
            for tls, j in self._junctions.items()
            if j.vehicle == vehicle_id and j.stage in ("clearing", "preempted")
        ]

    # ---- requests ------------------------------------------------------------------
    def request_preempt(
        self,
        now: float,
        tls_id: str,
        link_index: int,
        vehicle_id: str,
        vehicle_class: str,
        current_state: str,
        eta_s: float,
    ) -> Decision:
        j = self._junctions.get(tls_id)
        if j is None:
            return self._reject(now, tls_id, vehicle_id, "unknown", f"unknown junction {tls_id}")
        if vehicle_class != EMERGENCY_CLASS:
            return self._reject(
                now,
                tls_id,
                vehicle_id,
                "unauthorized",
                f"vehicle class '{vehicle_class}' may not preempt signals",
            )
        if j.stage in ("clearing", "preempted"):
            if j.vehicle == vehicle_id:
                return Decision(True, f"already {j.stage} for {vehicle_id}", "duplicate")
            return self._reject(
                now, tls_id, vehicle_id, "busy", f"{tls_id} is already preempted for {j.vehicle}"
            )
        if j.stage == "recovering":
            return self._reject(
                now,
                tls_id,
                vehicle_id,
                "recovering",
                f"{tls_id} is recovering from the previous preemption",
            )
        if j.resumed_at is not None and now - j.resumed_at < MIN_CROSS_GREEN_S - _EPS:
            return self._reject(
                now,
                tls_id,
                vehicle_id,
                "cooldown",
                f"cross traffic at {tls_id} keeps its green for "
                f"{MIN_CROSS_GREEN_S:.0f} s after recovery",
            )
        if not 0 <= link_index < j.table.link_count:
            return self._reject(
                now, tls_id, vehicle_id, "link", f"no link {link_index} at {tls_id}"
            )
        approach = j.table.approach_of[link_index]
        target = j.table.approach_exclusive_state(approach)
        steps = transition(current_state, target)
        problem = self._check_plan(j.table, current_state, steps)
        if problem:
            return self._reject(
                now, tls_id, vehicle_id, "unsafe", f"unsafe plan rejected: {problem}"
            )
        j.plan = deque(_Step(SetSignalState(tls_id, s), s, hold) for s, hold in steps)
        j.stage, j.vehicle, j.approach, j.accepted_at = "clearing", vehicle_id, approach, now
        j.step_started_at, j.last_reject = None, ""
        reason = (
            f"ETA {eta_s:.1f} s: clearing {tls_id} for {approach} "
            f"(yellow {YELLOW_S:.0f} s, all-red {ALL_RED_S:.0f} s)"
        )
        self._log(now, tls_id, vehicle_id, "preempt", True, reason)
        return Decision(True, reason, "accepted")

    def request_release(self, now: float, tls_id: str, vehicle_id: str, reason: str) -> Decision:
        j = self._junctions.get(tls_id)
        if j is None or j.stage not in ("clearing", "preempted"):
            return Decision(False, f"{tls_id} is not preempted", "not_preempted")
        if j.vehicle != vehicle_id:
            return self._reject(
                now,
                tls_id,
                vehicle_id,
                "not_owner",
                f"{tls_id} is preempted for {j.vehicle}, not {vehicle_id}",
            )
        self._log(now, tls_id, vehicle_id, "release", True, reason)
        self._start_recovery(now, j)
        return Decision(True, reason, "released")

    def release_all(self, now: float, reason: str, action: str = "release") -> None:
        """Recover every preempted junction (mode switched off, decision logic failed...)."""
        for tls, j in self._junctions.items():
            if j.stage in ("clearing", "preempted"):
                self._log(now, tls, j.vehicle, action, True, reason)
                self._start_recovery(now, j)

    # ---- clock -----------------------------------------------------------------------
    def step(self, now: float) -> list[Actuation]:
        """Actuations to apply before the next simulation step (at most one per junction)."""
        actions: list[Actuation] = []
        for tls, j in self._junctions.items():
            if j.stage == "preempted" and now - j.accepted_at >= MAX_PREEMPT_S - _EPS:
                self._log(
                    now,
                    tls,
                    j.vehicle,
                    "timeout",
                    True,
                    f"preemption reached {MAX_PREEMPT_S:.0f} s; recovering",
                )
                self._start_recovery(now, j)
            if not j.plan:
                continue
            if j.step_started_at is not None and now - j.step_started_at < j.hold_s - _EPS:
                continue
            step = j.plan.popleft()
            actions.append(step.action)
            j.applied, j.step_started_at, j.hold_s = step.state, now, step.hold_s
            if j.plan:
                continue
            if j.stage == "clearing":
                j.stage = "preempted"
                self.signals_preempted += 1
                self._log(now, tls, j.vehicle, "green", True, f"green for {j.approach}")
            elif j.stage == "recovering":
                assert isinstance(step.action, ResumeProgram)
                self._log(
                    now,
                    tls,
                    j.vehicle,
                    "resume",
                    True,
                    f"normal program resumed at phase {step.action.phase} "
                    f"(other direction's green)",
                )
                j.stage, j.vehicle, j.approach, j.resumed_at = "program", None, None, now
        return actions

    # ---- internals -------------------------------------------------------------------
    def _start_recovery(self, now: float, j: _Junction) -> None:
        tls = j.table.tls_id
        assert j.approach is not None
        current = j.applied if j.applied is not None else j.plan[0].state
        phase = j.table.recovery_phase(j.approach)
        steps = transition(current, j.table.phases[phase][0])
        problem = self._check_plan(j.table, current, steps)
        if problem:
            raise UnsafePlanError(f"{tls}: recovery plan breaks a safety rule: {problem}")
        plan = [_Step(SetSignalState(tls, s), s, hold) for s, hold in steps[:-1]]
        plan.append(_Step(ResumeProgram(tls, j.table.program_id, phase), steps[-1][0], 0.0))
        j.plan, j.stage, j.step_started_at = deque(plan), "recovering", None

    @staticmethod
    def _check_plan(table: SignalTable, current: str, steps: list[tuple[str, float]]) -> str:
        """Replay the plan through the same rules the monitor applies. '' if it is safe."""
        checker = SignalChecker(table)
        checker.prime(current, since=-3600.0)  # current state assumed long-standing
        t = 0.0
        for state, hold in steps:
            violations = checker.observe(t, state)
            if violations:
                return violations[0].detail
            t += hold
        return ""

    def _reject(self, now: float, tls: str, vehicle: str, code: str, reason: str) -> Decision:
        j = self._junctions.get(tls)
        if j is None or j.last_reject != code:  # the rule re-asks every tick: log changes only
            self._log(now, tls, vehicle, "preempt", False, reason)
            if j is not None:
                j.last_reject = code
        else:
            log.debug("t=%.1f %s %s: rejected again: %s", now, tls, vehicle, reason)
        return Decision(False, reason, code)

    def _log(
        self, now: float, tls: str, vehicle: str | None, action: str, accepted: bool, reason: str
    ) -> None:
        self.events.append(SafetyEvent(round(now, 3), tls, vehicle, action, accepted, reason))
        log.info(
            "t=%.1f %s %s %s %s: %s",
            now,
            tls,
            vehicle,
            action,
            "accepted" if accepted else "REJECTED",
            reason,
        )

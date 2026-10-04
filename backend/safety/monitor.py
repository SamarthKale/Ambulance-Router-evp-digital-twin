"""Independent safety monitor (CLAUDE.md section 8).

Checks what SUMO actually shows every tick, not what the controller intended, so a bug
anywhere between decision and actuation shows up as a violation. Reported violations
plus SUMO collisions are the "safety violations" metric (must stay 0).
"""

from __future__ import annotations

import logging
from collections import deque
from collections.abc import Iterable, Mapping

from safety.invariants import SignalChecker, Violation
from safety.signal_table import SignalTable

log = logging.getLogger(__name__)


class SafetyMonitor:
    def __init__(self, tables: Mapping[str, SignalTable]) -> None:
        self._checkers = {tls: SignalChecker(table) for tls, table in tables.items()}
        self.violations = 0
        self.recent: deque[Violation] = deque(maxlen=50)

    def observe(self, time: float, states: Iterable[tuple[str, str]]) -> list[Violation]:
        """`states`: (junction id, observed signal state) for every signalized junction."""
        found: list[Violation] = []
        for tls, state in states:
            checker = self._checkers.get(tls)
            if checker is not None:
                found.extend(checker.observe(time, state))
        for violation in found:
            log.error("SAFETY VIOLATION %s", violation)
        self.violations += len(found)
        self.recent.extend(found)
        return found

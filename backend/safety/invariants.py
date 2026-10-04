"""Signal safety rules (CLAUDE.md section 8), checked on a sequence of observed states.

Used by the independent monitor on what SUMO actually shows, and by the controller to
verify a plan before accepting it.

  R1  no two conflicting links are priority green (G) at the same time
  R2  a green link must turn yellow before red; yellow lasts >= 4 s; yellow never
      returns to green
  R3  a link may turn green (r->G, r->g) or gain priority (g->G) only if every
      conflicting link was red for the previous >= 2 s (all-red clearance)

Times are observation times (see the timing rule in CLAUDE.md section 6): durations are
differences between observed switch times.
"""

from __future__ import annotations

from dataclasses import dataclass

from safety.signal_table import GREEN, SignalTable

YELLOW_MIN_S = 4.0
ALL_RED_MIN_S = 2.0
_EPS = 1e-6


@dataclass(frozen=True)
class Violation:
    time: float
    junction: str
    rule: str  # R1, R2, R3
    detail: str


class SignalChecker:
    """Tracks one junction's observed state history and reports rule violations."""

    def __init__(self, table: SignalTable) -> None:
        self.table = table
        self._prev: str | None = None
        self._since: list[float] = []  # when each link's current signal started

    def prime(self, state: str, since: float) -> None:
        """Start from a state that has been showing since `since` (for plan checks)."""
        self._prev = state
        self._since = [since] * len(state)

    def observe(self, time: float, state: str) -> list[Violation]:
        table = self.table
        tls = table.tls_id
        if len(state) != table.link_count:
            return [
                Violation(
                    time,
                    tls,
                    "R0",
                    f"state has {len(state)} links, expected {table.link_count}",
                )
            ]
        found = [
            Violation(time, tls, "R1", f"links {i} and {j} conflict but are both green (G)")
            for i, j in table.conflicting_greens(state)
        ]
        prev = self._prev
        if prev is None:
            self._prev, self._since = state, [time] * len(state)
            return found
        for j, (was, now) in enumerate(zip(prev, state, strict=True)):
            if was == now:
                continue
            if was in GREEN and now == "r":
                found.append(Violation(time, tls, "R2", f"link {j} went {was}->r without yellow"))
            elif was == "y" and now in GREEN:
                found.append(Violation(time, tls, "R2", f"link {j} went yellow->green"))
            elif was == "y" and now == "r" and time - self._since[j] < YELLOW_MIN_S - _EPS:
                lasted = time - self._since[j]
                found.append(Violation(time, tls, "R2", f"link {j} yellow lasted {lasted:.1f} s"))
            if (now in GREEN and was not in GREEN) or (was == "g" and now == "G"):
                for i in sorted(table.foes[j]):
                    if prev[i] != "r":
                        found.append(
                            Violation(
                                time,
                                tls,
                                "R3",
                                f"link {j} turned {now} while conflicting link {i} "
                                f"was {prev[i]}",
                            )
                        )
                    elif time - self._since[i] < ALL_RED_MIN_S - _EPS:
                        red_for = time - self._since[i]
                        found.append(
                            Violation(
                                time,
                                tls,
                                "R3",
                                f"link {j} turned {now} after conflicting link {i} "
                                f"was red for only {red_for:.1f} s",
                            )
                        )
        for j, (was, now) in enumerate(zip(prev, state, strict=True)):
            if was != now:
                self._since[j] = time
        self._prev = state
        return found

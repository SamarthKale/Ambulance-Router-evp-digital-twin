"""Static facts about one signalized junction, as the safety layer sees it (no TraCI)."""

from __future__ import annotations

from dataclasses import dataclass

GREEN = frozenset("Gg")  # G = priority green, g = green but must yield


@dataclass(frozen=True)
class SignalTable:
    tls_id: str
    foes: tuple[frozenset[int], ...]  # per signal link index: the links it conflicts with
    approach_of: tuple[str, ...]  # per signal link index: incoming edge
    program_id: str  # the normal (fixed-time) program
    phases: tuple[tuple[str, float], ...]  # normal program: (state, duration s)

    @property
    def link_count(self) -> int:
        return len(self.foes)

    def approach_links(self, approach: str) -> frozenset[int]:
        return frozenset(i for i, edge in enumerate(self.approach_of) if edge == approach)

    def conflicting_greens(self, state: str) -> list[tuple[int, int]]:
        """Pairs of conflicting links that are both priority green (G)."""
        priority = [i for i, c in enumerate(state) if c == "G"]
        return [(i, j) for i in priority for j in priority if i < j and j in self.foes[i]]

    def approach_exclusive_state(self, approach: str) -> str:
        """Every movement from one approach green, everything else red."""
        links = self.approach_links(approach)
        if not links:
            raise ValueError(f"{self.tls_id} has no links from {approach}")
        return "".join("G" if i in links else "r" for i in range(self.link_count))

    def recovery_phase(self, approach: str) -> int:
        """The normal program's green phase for the other direction: it gives green to the
        most links while giving none to the preempted approach."""
        links = self.approach_links(approach)
        candidates = [
            (sum(c in GREEN for c in state), index)
            for index, (state, _) in enumerate(self.phases)
            if any(c in GREEN for c in state) and not any(state[i] in GREEN for i in links)
        ]
        if not candidates:
            raise ValueError(f"{self.tls_id}: no green phase without {approach}")
        return max(candidates)[1]

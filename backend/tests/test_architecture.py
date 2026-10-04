"""Guard tests for the architecture rules in CLAUDE.md (sections 2.3, 6 and 17)."""

from __future__ import annotations

import ast
from collections.abc import Iterator
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
SIGNAL_SETTERS = {
    "setRedYellowGreenState",
    "setProgram",
    "setPhase",
    "setPhaseDuration",
    "setProgramLogic",
    "setCompleteRedYellowGreenDefinition",
    "setLinkState",
}
ACTUATION_MODULE = Path("simulation/traffic_lights.py")


def sources() -> Iterator[tuple[Path, ast.Module]]:
    for path in sorted(BACKEND.rglob("*.py")):
        relative = path.relative_to(BACKEND)
        if relative.parts[0].startswith("."):
            continue  # .venv, caches
        yield relative, ast.parse(path.read_text(encoding="utf-8-sig"))


def imported_modules(tree: ast.Module) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0])
    return names


def test_only_the_actuation_layer_sets_signals() -> None:
    offenders = [
        f"{path}:{node.lineno} {node.attr}"
        for path, tree in sources()
        if path != ACTUATION_MODULE
        for node in ast.walk(tree)
        if isinstance(node, ast.Attribute) and node.attr in SIGNAL_SETTERS
    ]
    assert offenders == []


def test_traci_is_only_imported_by_the_simulation_layer() -> None:
    offenders = [
        str(path)
        for path, tree in sources()
        if path.parts[0] != "simulation" and imported_modules(tree) & {"traci", "libsumo"}
    ]
    assert offenders == []


def test_decision_and_safety_layers_stay_pure() -> None:
    offenders = [
        f"{path} imports {sorted(imported_modules(tree) & {'simulation', 'api', 'sumolib'})}"
        for path, tree in sources()
        if path.parts[0] in ("ai", "safety")
        and imported_modules(tree) & {"simulation", "api", "sumolib"}
    ]
    assert offenders == []

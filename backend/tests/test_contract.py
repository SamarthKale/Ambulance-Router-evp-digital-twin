"""Sprint 4: protocol contract between backend models and frontend types.

The frontend half lives in frontend/src/simulation/contract.test.ts and in tsc, which
type-checks the generated fixtures against state.ts.
"""

from __future__ import annotations

from typing import get_args

from api.protocol import AckMsg, ErrorMsg, SessionMsg, StateMsg
from scripts.gen_contract import (
    OUTPUT,
    SERVER_TYPES,
    command_examples,
    command_names,
    network_fixtures,
    render,
)

STALE = "is stale: run `.venv\\Scripts\\python.exe -m scripts.gen_contract`"


def test_frontend_fixtures_are_up_to_date() -> None:
    assert (
        OUTPUT.read_text(encoding="utf-8") == render()
    ), f"frontend/src/simulation/contract.fixtures.ts {STALE} and fix state.ts if tsc complains"


def test_network_fixtures_are_up_to_date() -> None:
    """The city layout tests (frontend) run on the shipped scenarios' real networks."""
    for path, text in network_fixtures().items():
        assert path.exists() and path.read_text(encoding="utf-8") == text, f"{path.name} {STALE}"


def test_every_command_is_covered_by_an_example() -> None:
    assert sorted(e["cmd"] for e in command_examples()) == sorted(command_names())


def test_every_server_message_type_is_listed() -> None:
    types = {
        get_args(m.model_fields["type"].annotation)[0]
        for m in (StateMsg, AckMsg, ErrorMsg, SessionMsg)
    }
    assert types == set(SERVER_TYPES)

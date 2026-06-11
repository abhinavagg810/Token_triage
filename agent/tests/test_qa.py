from __future__ import annotations

import os
import sqlite3

import pytest
from langchain_core.messages import AIMessage

from agent.qa import ask
from tests.fakes import script, tool_call


def test_ask_grounds_in_tools_and_logs_usage(fixture_db: str) -> None:
    model = script(
        tool_call("get_findings", {}, "call_1"),
        AIMessage(
            "Day 12 was expensive because of a retry storm: ~412 duplicate calls, "
            "about $42/month of waste (estimate)."
        ),
    )
    answer, usage = ask("why was day 12 expensive?", fixture_db, model=model)
    assert "retry" in answer.lower()
    assert "$42" in answer

    runs = sqlite3.connect(fixture_db).execute(
        "SELECT kind, question FROM agent_runs"
    ).fetchall()
    assert runs == [("ask", "why was day 12 expensive?")]


@pytest.mark.skipif(not os.environ.get("ANTHROPIC_API_KEY"), reason="needs ANTHROPIC_API_KEY")
def test_ask_live(fixture_db: str) -> None:
    answer, usage = ask("why was day 12 expensive?", fixture_db)
    lowered = answer.lower()
    assert "retry" in lowered or "duplicate" in lowered
    assert usage.llm_calls >= 1

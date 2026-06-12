from __future__ import annotations

import os
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage

from agent.investigate import build_graph, detect_anomaly
from agent.usage import UsageTracker
from tests.fakes import script, tool_call


def test_detect_anomaly_finds_day_12(fixture_db: str) -> None:
    anomaly = detect_anomaly(fixture_db, None)
    assert anomaly["date"] == "2026-05-12"
    assert anomaly["usd"] == 86.32
    assert anomaly["deviation_x"] > 2


def test_detect_anomaly_rejects_unknown_date(fixture_db: str) -> None:
    with pytest.raises(RuntimeError, match="No spend recorded"):
        detect_anomaly(fixture_db, "2027-01-01")


def test_graph_happy_path_writes_report(fixture_db: str) -> None:
    model = script(
        # hypothesize
        AIMessage("The day-12 spike was caused by a retry storm of duplicate webhook calls."),
        # investigate: two tool calls, then a summary with no tool calls
        tool_call("spend_by_day", {"start": "2026-05-10", "end": "2026-05-14"}, "c1"),
        tool_call("get_findings", {}, "c2"),
        AIMessage("Evidence gathered: day 12 spent $86.32 vs $30 median; retry-waste finding."),
        # verify
        AIMessage("SUPPORTED"),
        # write_report
        AIMessage(
            "## Incident\nDay 2026-05-12 spend spiked to $86.32 (2.9x median).\n"
            "## Root cause\nRetry storm: duplicate webhook calls.\n"
            "## Evidence\n412 wasted calls pinned to 2026-05-12; retry-waste finding $41.88.\n"
            "## $ impact\n~$42/month.\n## Fix\nIdempotency key + exponential backoff."
        ),
    )
    usage = UsageTracker(model="scripted")
    graph = build_graph(fixture_db, model, usage).compile()
    final = graph.invoke({"date": "", "retries": 0})

    assert final["anomaly"]["date"] == "2026-05-12"
    assert final["verdict"] == "supported"
    assert [e["tool"] for e in final["evidence"]] == ["spend_by_day", "get_findings"]
    assert "retry" in final["report"].lower()
    assert "$41.88" in final["report"]


def test_graph_retries_rejected_hypothesis(fixture_db: str) -> None:
    model = script(
        AIMessage("Hypothesis A: a new expensive model was rolled out on day 12."),
        AIMessage("No evidence needed."),  # investigate round 1: no tool calls
        AIMessage("UNSUPPORTED: model mix did not change on day 12."),  # verify 1
        AIMessage("Hypothesis B: duplicate retry calls caused the spike."),  # hypothesize 2
        tool_call("get_findings", {}, "c1"),
        AIMessage("retry-waste finding confirms duplicates on day 12."),
        AIMessage("SUPPORTED"),  # verify 2
        AIMessage("## Incident\nRetry storm on 2026-05-12.\n## Root cause\nDuplicates."),
    )
    graph = build_graph(fixture_db, model).compile()
    final = graph.invoke({"date": "2026-05-12", "retries": 0})

    assert final["failed_hypotheses"] == ["Hypothesis A: a new expensive model was rolled out on day 12."]
    assert final["verdict"] == "supported"
    assert "retry" in final["report"].lower()


@pytest.mark.skipif(not os.environ.get("ANTHROPIC_API_KEY"), reason="needs ANTHROPIC_API_KEY")
def test_investigation_live(fixture_db: str) -> None:
    from agent.llm import get_model

    usage = UsageTracker(model="live")
    graph = build_graph(fixture_db, get_model(), usage).compile()
    final = graph.invoke({"date": "2026-05-12", "retries": 0})
    lowered = final["report"].lower()
    assert "retry" in lowered or "duplicate" in lowered
    assert usage.llm_calls >= 3


def test_checkpoints_persist_and_are_resumable(fixture_db: str, tmp_path: Path) -> None:
    from langgraph.checkpoint.sqlite import SqliteSaver

    ckpt = str(tmp_path / "checkpoints.sqlite")
    model = script(
        AIMessage("Retry storm hypothesis."),
        AIMessage("No tools needed; the findings table already pins day 12."),
        AIMessage("SUPPORTED"),
        AIMessage("## Incident\nRetry storm on 2026-05-12."),
    )
    config = {"configurable": {"thread_id": "investigate-2026-05-12"}}
    with SqliteSaver.from_conn_string(ckpt) as saver:
        graph = build_graph(fixture_db, model).compile(checkpointer=saver)
        final = graph.invoke({"date": "2026-05-12", "retries": 0}, config=config)
        assert graph.get_state(config).values["report"] == final["report"]
    assert Path(ckpt).exists()

    # Reopen the checkpoint store (as a new process would): state survives.
    with SqliteSaver.from_conn_string(ckpt) as saver:
        graph = build_graph(fixture_db, script()).compile(checkpointer=saver)
        state = graph.get_state(config)
        assert state.values["verdict"] == "supported"
        assert "Retry storm" in state.values["report"]

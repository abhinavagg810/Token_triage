"""Investigation agent — an explicit LangGraph StateGraph:

    detect_anomaly -> hypothesize -> investigate (tool loop, max 6 calls)
        -> verify --(unsupported, <=2 retries)--> hypothesize
                  --(otherwise)----------------> write_report

State is a TypedDict; runs are resumable via a SQLite checkpointer (see cli.py).
"""

from __future__ import annotations

import json
import statistics
from typing import Annotated, Any, TypedDict

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import END, START, StateGraph

from .db import capped_json, connect_readonly
from .tools import make_tools
from .usage import UsageTracker

MAX_TOOL_CALLS_PER_INVESTIGATION = 6
MAX_HYPOTHESIS_RETRIES = 2

SYSTEM = SystemMessage(
    """You are TokenTriage's incident investigator for LLM API spend. You work \
from a local audit database (token counts, hashes, costs — never prompt \
content). Be precise, cite concrete numbers, and never invent data."""
)


def _last(values: list[str] | str | None, fallback: str = "") -> str:
    if isinstance(values, list):
        return values[-1] if values else fallback
    return values or fallback


def _append(left: list[Any], right: list[Any] | Any) -> list[Any]:
    if not isinstance(right, list):
        right = [right]
    return left + right


class InvestigationState(TypedDict, total=False):
    date: str
    anomaly: dict[str, Any]
    hypothesis: str
    failed_hypotheses: Annotated[list[str], _append]
    evidence: Annotated[list[dict[str, Any]], _append]
    verdict: str
    retries: int
    report: str


def detect_anomaly(db_path: str, date: str | None) -> dict[str, Any]:
    """Pure-Python anomaly detection over daily_spend. If `date` is given it is
    investigated directly; otherwise the day deviating most from the median wins."""
    with connect_readonly(db_path) as conn:
        rows = conn.execute("SELECT date, usd, requests FROM daily_spend ORDER BY date").fetchall()
    if not rows:
        raise RuntimeError("daily_spend is empty — nothing to investigate.")
    by_date = {r["date"]: (r["usd"], r["requests"]) for r in rows}
    median = statistics.median(usd for usd, _ in by_date.values())

    if date:
        if date not in by_date:
            raise RuntimeError(f"No spend recorded on {date} (period: {rows[0]['date']}..{rows[-1]['date']}).")
        target = date
    else:
        target = max(by_date, key=lambda d: abs(by_date[d][0] - median))

    usd, requests = by_date[target]
    return {
        "date": target,
        "usd": round(usd, 2),
        "requests": requests,
        "median_daily_usd": round(median, 2),
        "deviation_x": round(usd / median, 2) if median > 0 else None,
    }


def build_graph(db_path: str, model: BaseChatModel, usage: UsageTracker | None = None) -> StateGraph:
    """Build the (uncompiled) investigation graph bound to one DB and model."""
    tools = make_tools(db_path)
    tools_by_name = {t.name: t for t in tools}
    tool_model = model.bind_tools(tools)
    track = usage.add_message if usage else (lambda _m: None)

    def node_detect(state: InvestigationState) -> dict[str, Any]:
        anomaly = detect_anomaly(db_path, state.get("date") or None)
        return {"anomaly": anomaly, "date": anomaly["date"], "retries": state.get("retries", 0)}

    def node_hypothesize(state: InvestigationState) -> dict[str, Any]:
        failed = state.get("failed_hypotheses", [])
        prior = (
            "\n\nPreviously rejected hypotheses (do NOT repeat them):\n- " + "\n- ".join(failed)
            if failed
            else ""
        )
        msg = HumanMessage(
            f"Spend anomaly detected: {json.dumps(state['anomaly'])}\n"
            f"Available investigation tools: {', '.join(tools_by_name)}.\n"
            f"State ONE specific, checkable hypothesis (a single sentence) for the root "
            f"cause of this anomaly.{prior}"
        )
        response = tool_model.invoke([SYSTEM, msg])
        track(response)
        return {"hypothesis": response.text.strip()}

    def node_investigate(state: InvestigationState) -> dict[str, Any]:
        messages: list[Any] = [
            SYSTEM,
            HumanMessage(
                f"Anomaly: {json.dumps(state['anomaly'])}\n"
                f"Hypothesis to test: {state['hypothesis']}\n"
                f"Use the tools (at most {MAX_TOOL_CALLS_PER_INVESTIGATION} calls) to gather "
                f"evidence for or against the hypothesis, then summarize what you found."
            ),
        ]
        evidence: list[dict[str, Any]] = []
        calls = 0
        while calls < MAX_TOOL_CALLS_PER_INVESTIGATION:
            response = tool_model.invoke(messages)
            track(response)
            messages.append(response)
            if not response.tool_calls:
                break
            for tc in response.tool_calls:
                if calls >= MAX_TOOL_CALLS_PER_INVESTIGATION:
                    messages.append(
                        ToolMessage("(tool budget exhausted)", tool_call_id=tc["id"])
                    )
                    continue
                calls += 1
                tool_fn = tools_by_name.get(tc["name"])
                result = (
                    tool_fn.invoke(tc["args"]) if tool_fn else f"unknown tool {tc['name']!r}"
                )
                evidence.append({"tool": tc["name"], "args": tc["args"], "result": result})
                messages.append(ToolMessage(str(result), tool_call_id=tc["id"]))
        return {"evidence": evidence}

    def node_verify(state: InvestigationState) -> dict[str, Any]:
        response = tool_model.invoke(
            [
                SYSTEM,
                HumanMessage(
                    f"Hypothesis: {state['hypothesis']}\n"
                    f"Evidence collected:\n{capped_json(state.get('evidence', []))}\n\n"
                    f'Does the evidence support the hypothesis? Reply with exactly '
                    f'"SUPPORTED" or "UNSUPPORTED: <one-line reason>".'
                ),
            ]
        )
        track(response)
        text = response.text.strip()
        supported = text.upper().startswith("SUPPORTED")
        out: dict[str, Any] = {"verdict": "supported" if supported else "unsupported"}
        if not supported:
            out["failed_hypotheses"] = [state["hypothesis"]]
            out["retries"] = state.get("retries", 0) + 1
        return out

    def route_after_verify(state: InvestigationState) -> str:
        if state.get("verdict") == "supported" or state.get("retries", 0) > MAX_HYPOTHESIS_RETRIES:
            return "write_report"
        return "hypothesize"

    def node_write_report(state: InvestigationState) -> dict[str, Any]:
        caveat = (
            ""
            if state.get("verdict") == "supported"
            else "\nNote: no hypothesis was fully confirmed — present the best-supported "
            "explanation and clearly mark the uncertainty."
        )
        response = tool_model.invoke(
            [
                SYSTEM,
                HumanMessage(
                    f"Write a markdown incident report for this spend anomaly.\n"
                    f"Anomaly: {json.dumps(state['anomaly'])}\n"
                    f"Confirmed cause: {state['hypothesis']}\n"
                    f"Evidence:\n{capped_json(state.get('evidence', []))}\n\n"
                    f"Sections (use these exact headers): ## Incident, ## Root cause, "
                    f"## Evidence, ## $ impact, ## Fix. Cite concrete numbers; keep it "
                    f"under 350 words.{caveat}"
                ),
            ]
        )
        track(response)
        return {"report": response.text.strip()}

    graph: StateGraph = StateGraph(InvestigationState)
    graph.add_node("detect_anomaly", node_detect)
    graph.add_node("hypothesize", node_hypothesize)
    graph.add_node("investigate", node_investigate)
    graph.add_node("verify", node_verify)
    graph.add_node("write_report", node_write_report)
    graph.add_edge(START, "detect_anomaly")
    graph.add_edge("detect_anomaly", "hypothesize")
    graph.add_edge("hypothesize", "investigate")
    graph.add_edge("investigate", "verify")
    graph.add_conditional_edges(
        "verify", route_after_verify, {"write_report": "write_report", "hypothesize": "hypothesize"}
    )
    graph.add_edge("write_report", END)
    return graph

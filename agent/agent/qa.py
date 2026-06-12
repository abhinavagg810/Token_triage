"""Spend Q&A agent — LangChain 1.x create_agent over the six DB tools."""

from __future__ import annotations

from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from .llm import get_model
from .tools import make_tools
from .usage import UsageTracker, log_run

# Static system prompt, structured so Anthropic prompt caching applies
# (stable text first, no per-request content).
SYSTEM_PROMPT = """You are TokenTriage's spend analyst. You answer questions about an \
LLM API bill using ONLY the provided database tools over the audited period.

Rules:
1. Ground every claim in tool results. Call get_findings first when the user \
asks any "why" question about cost or waste; use the other tools to drill in.
2. Cite concrete numbers: dollars, percentages, request counts, dates, token \
counts. Round dollars to whole numbers unless precision matters.
3. If the tools cannot answer the question, say "I don't have data for that" \
and state what data would be needed. Never guess or extrapolate beyond the \
audited period.
4. Be concise: a short direct answer first, then the supporting numbers.
5. All figures are estimates from a local audit; label projected savings as \
estimates."""

# Static block marked for Anthropic prompt caching — repeat questions in a
# session re-read the system prompt at 10% of input price.
CACHED_SYSTEM = SystemMessage(
    content=[
        {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}
    ]
)


def ask(
    question: str,
    db_path: str,
    model: BaseChatModel | None = None,
    log_usage: bool = True,
) -> tuple[str, UsageTracker]:
    """Answer one question grounded in the SQLite export. Returns (answer, usage)."""
    llm = model or get_model()
    tools = make_tools(db_path)
    agent = create_agent(llm, tools, system_prompt=CACHED_SYSTEM)

    result = agent.invoke({"messages": [HumanMessage(question)]})
    messages = result["messages"]

    usage = UsageTracker(model=getattr(llm, "model", getattr(llm, "model_name", "unknown")))
    usage.add_messages(messages)
    if log_usage:
        log_run(db_path, "ask", question, usage)

    final = next((m for m in reversed(messages) if isinstance(m, AIMessage)), None)
    return (final.text if final else "(no answer produced)", usage)

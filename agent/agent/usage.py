"""Track the agent's own token usage and log it to agent_runs — TokenTriage
audits itself."""

from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage


@dataclass
class UsageTracker:
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    llm_calls: int = 0
    _seen: set[str] = field(default_factory=set)

    def add_message(self, message: BaseMessage) -> None:
        if not isinstance(message, AIMessage):
            return
        key = message.id or str(id(message))
        if key in self._seen:
            return
        self._seen.add(key)
        usage: dict[str, Any] = message.usage_metadata or {}
        if not usage:
            return
        self.llm_calls += 1
        self.input_tokens += int(usage.get("input_tokens") or 0)
        self.output_tokens += int(usage.get("output_tokens") or 0)
        details = usage.get("input_token_details") or {}
        self.cache_read_tokens += int(details.get("cache_read") or 0)

    def add_messages(self, messages: list[BaseMessage]) -> None:
        for m in messages:
            self.add_message(m)

    def summary(self) -> str:
        return (
            f"agent tokens: {self.input_tokens:,} in / {self.output_tokens:,} out "
            f"({self.cache_read_tokens:,} cached) over {self.llm_calls} LLM call(s)"
        )


def log_run(db_path: str, kind: str, question: str | None, usage: UsageTracker) -> str:
    """Insert a row into agent_runs (write connection — the only write the
    agent ever performs, and it contains no log content)."""
    run_id = f"run_{uuid.uuid4().hex[:12]}"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS agent_runs (
                 id TEXT PRIMARY KEY, started_at TEXT NOT NULL, kind TEXT NOT NULL,
                 model TEXT NOT NULL, question TEXT,
                 input_tokens INTEGER NOT NULL DEFAULT 0,
                 output_tokens INTEGER NOT NULL DEFAULT 0,
                 cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                 llm_calls INTEGER NOT NULL DEFAULT 0)"""
        )
        conn.execute(
            "INSERT INTO agent_runs VALUES (?,?,?,?,?,?,?,?,?)",
            (
                run_id,
                datetime.now(UTC).isoformat(),
                kind,
                usage.model,
                question,
                usage.input_tokens,
                usage.output_tokens,
                usage.cache_read_tokens,
                usage.llm_calls,
            ),
        )
    return run_id

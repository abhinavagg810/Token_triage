"""Model factory. The agent's LLM calls are the only network calls in this
service, using the user's own key (ANTHROPIC_API_KEY)."""

from __future__ import annotations

import os

from langchain_anthropic import ChatAnthropic
from langchain_core.language_models.chat_models import BaseChatModel

DEFAULT_MODEL = "claude-sonnet-4-5"


def get_model() -> BaseChatModel:
    model = os.environ.get("TOKENTRIAGE_AGENT_MODEL", DEFAULT_MODEL)
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise RuntimeError("ANTHROPIC_API_KEY is not set — the agent uses your own key.")
    return ChatAnthropic(model_name=model, max_tokens=2048, timeout=120, stop=None)

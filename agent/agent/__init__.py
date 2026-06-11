"""TokenTriage agent service: spend Q&A + investigation agents (LangGraph).

Reads the SQLite database exported by the core CLI (`tokentriage analyze --db`,
schema in docs/db-schema.md). The database contains hashes and token counts
only — never prompt bodies (core privacy invariant).
"""

__version__ = "0.1.0"

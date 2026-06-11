"""Read access to the TokenTriage SQLite export + response budgeting.

Every tool response is capped (~2,000 tokens) — we are not going to build a
token auditor that wastes tokens.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

SUPPORTED_SCHEMA_VERSION = "1"
MAX_TOOL_TOKENS = 2_000
_CHARS_PER_TOKEN = 4  # conservative approximation


class SchemaError(RuntimeError):
    pass


def connect_readonly(db_path: str | Path) -> sqlite3.Connection:
    """Open the export read-only and verify the schema version."""
    path = Path(db_path)
    if not path.exists():
        raise FileNotFoundError(
            f"Database not found: {path}. Export one with: tokentriage analyze <logs> --db {path}"
        )
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    except sqlite3.OperationalError as exc:
        conn.close()
        raise SchemaError(f"{path} is not a TokenTriage export (missing meta table)") from exc
    if row is None or row["value"] != SUPPORTED_SCHEMA_VERSION:
        conn.close()
        raise SchemaError(
            f"Unsupported schema_version {row['value'] if row else 'missing'} "
            f"(agent supports {SUPPORTED_SCHEMA_VERSION}). Re-export with a matching core CLI."
        )
    return conn


def rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]


def capped_json(payload: Any, max_tokens: int = MAX_TOOL_TOKENS) -> str:
    """Serialize compactly; if over budget, truncate list payloads and say so."""
    budget = max_tokens * _CHARS_PER_TOKEN
    text = json.dumps(payload, separators=(",", ":"), default=str)
    if len(text) <= budget:
        return text
    if isinstance(payload, list):
        kept = list(payload)
        while len(kept) > 1:
            kept = kept[: max(1, len(kept) // 2)]
            text = json.dumps(
                {"truncated": True, "shown": len(kept), "items": kept},
                separators=(",", ":"),
                default=str,
            )
            if len(text) <= budget:
                return text
    return text[: budget - 20] + '... (truncated)"'

"""Fixture database mirroring docs/db-schema.md (schema v1) with the
Meridian Labs story: a day-12 retry storm, an uncached copilot prefix, and a
bloated agent session."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE requests (
  id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, ts INTEGER, provider TEXT NOT NULL,
  model TEXT NOT NULL, normalized_model TEXT NOT NULL, service TEXT,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
  status INTEGER NOT NULL, latency_ms INTEGER NOT NULL, session_id TEXT,
  system_prompt_hash TEXT, full_prompt_hash TEXT, max_tokens_set INTEGER NOT NULL,
  cost_usd REAL NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, inferred INTEGER NOT NULL, turns INTEGER NOT NULL,
  first_ts TEXT NOT NULL, last_ts TEXT NOT NULL, first_input_tokens INTEGER NOT NULL,
  last_input_tokens INTEGER NOT NULL, total_cost_usd REAL NOT NULL
);
CREATE TABLE findings (
  analyzer_id TEXT PRIMARY KEY, name TEXT NOT NULL, wasted_usd REAL NOT NULL,
  pct_of_total REAL NOT NULL, confidence TEXT NOT NULL, upper_bound INTEGER NOT NULL,
  projected_monthly_savings_usd REAL NOT NULL, evidence_json TEXT NOT NULL,
  fix_json TEXT NOT NULL, details_json TEXT
);
CREATE TABLE daily_spend (date TEXT PRIMARY KEY, usd REAL NOT NULL, requests INTEGER NOT NULL);
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL,
  question TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0
);
"""

COPILOT_HASH = "a3f9c2" + "0" * 58
DUP_HASH = "feed42" + "0" * 58


@pytest.fixture()
def fixture_db(tmp_path: Path) -> Iterator[str]:
    path = tmp_path / "fixture.db"
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)

    meta = {
        "schema_version": "1",
        "generated_at": "2026-06-01T00:00:00Z",
        "period_start": "2026-05-01",
        "period_end": "2026-05-30",
        "days_in_dataset": "30",
        "total_spend_usd": "919.70",
        "addressable_waste_usd": "446.47",
        "request_count": "10133",
    }
    conn.executemany("INSERT INTO meta VALUES (?,?)", meta.items())

    # daily spend: flat ~$30/day except the day-12 retry storm
    for d in range(1, 31):
        date = f"2026-05-{d:02d}"
        conn.execute(
            "INSERT INTO daily_spend VALUES (?,?,?)",
            (date, 86.32 if d == 12 else 30.0, 800 if d == 12 else 330),
        )

    rid = 0

    def req(
        date: str,
        model: str = "claude-sonnet-4-5",
        cost: float = 0.05,
        *,
        sys_hash: str | None = None,
        full_hash: str | None = None,
        session: str | None = None,
        input_tokens: int = 1000,
        service: str = "support-copilot",
    ) -> None:
        nonlocal rid
        rid += 1
        conn.execute(
            "INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                f"req_{rid:05d}", f"{date}T10:00:{rid % 60:02d}.000Z", None, "anthropic",
                model, model, service, input_tokens, 300, 0, 0, 200, 1500, session,
                sys_hash, full_hash, 1, cost,
            ),
        )

    # uncached copilot prefix (12 occurrences)
    for _ in range(12):
        req("2026-05-03", sys_hash=COPILOT_HASH, input_tokens=38_000, cost=0.12)
    # day-12 duplicate storm (one hash sent 3x)
    for _ in range(3):
        req("2026-05-12", full_hash=DUP_HASH, input_tokens=25_000, cost=0.08, service="webhook-router")
    # a bloated agent session
    for turn in range(14):
        req(
            "2026-05-07",
            session="sess_001",
            input_tokens=3_500 + 4_300 * turn,
            cost=0.10,
            service="hr-agent",
        )
    conn.execute(
        "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)",
        ("sess_001", 0, 14, "2026-05-07T10:00:00Z", "2026-05-07T10:09:00Z", 3500, 59400, 1.42),
    )

    findings = [
        ("cache-miss", "Prompt caching not used", 261.0, 0.284, "high", 0, 261,
         '[{"label":"Prefix 1 of 3","detail":"a3f9c2 sent 2,400x on claude-sonnet-4-5"}]',
         '{"summary":"Enable prompt caching"}', None),
        ("context-bloat", "Context bloat (agents)", 93.46, 0.102, "high", 0, 93,
         '[{"label":"Bloated sessions","detail":"110 sessions grew >3x"}]',
         '{"summary":"Sliding window"}', None),
        ("retry-waste", "Retry/duplicate calls", 41.88, 0.046, "high", 0, 42,
         '[{"label":"Hotspot","detail":"412 wasted calls on 2026-05-12 - check deploys/incidents"}]',
         '{"summary":"Idempotency key + backoff"}', None),
        ("model-overkill", "Model overkill", 31.05, 0.034, "medium", 1, 31,
         '[{"label":"claude-opus-4-1","detail":"1,100 short calls"}]',
         '{"summary":"Route to a budget model"}', None),
        ("verbose-output", "Verbose output (no max_tokens)", 19.08, 0.021, "low", 0, 19,
         '[{"label":"Uncapped calls","detail":"148 calls above p90"}]',
         '{"summary":"Set max_tokens"}', None),
    ]
    conn.executemany("INSERT INTO findings VALUES (?,?,?,?,?,?,?,?,?,?)", findings)
    conn.commit()
    conn.close()
    yield str(path)

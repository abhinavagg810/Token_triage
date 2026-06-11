from __future__ import annotations

import json

from agent.db import capped_json
from agent.tools import make_tools


def tools_by_name(db_path: str) -> dict:
    return {t.name: t for t in make_tools(db_path)}


def test_six_tools_exposed(fixture_db: str) -> None:
    names = set(tools_by_name(fixture_db))
    assert names == {
        "spend_by_model",
        "spend_by_day",
        "top_sessions",
        "find_prefix",
        "compare_periods",
        "get_findings",
    }


def test_spend_by_day_finds_day12_spike(fixture_db: str) -> None:
    rows = json.loads(tools_by_name(fixture_db)["spend_by_day"].invoke({}))
    by_date = {r["date"]: r["usd"] for r in rows}
    assert by_date["2026-05-12"] == 86.32
    assert by_date["2026-05-11"] == 30.0
    # date filtering
    filtered = json.loads(
        tools_by_name(fixture_db)["spend_by_day"].invoke({"start": "2026-05-12", "end": "2026-05-12"})
    )
    assert len(filtered) == 1 and filtered[0]["date"] == "2026-05-12"


def test_get_findings_ranked_by_waste(fixture_db: str) -> None:
    rows = json.loads(tools_by_name(fixture_db)["get_findings"].invoke({}))
    assert [r["analyzer_id"] for r in rows][:3] == ["cache-miss", "context-bloat", "retry-waste"]
    retry = next(r for r in rows if r["analyzer_id"] == "retry-waste")
    assert retry["wasted_usd"] == 41.88
    assert "2026-05-12" in retry["evidence_json"]


def test_find_prefix_matches_partial_hash(fixture_db: str) -> None:
    rows = json.loads(tools_by_name(fixture_db)["find_prefix"].invoke({"hash_prefix": "a3f9c2"}))
    assert rows[0]["occurrences"] == 12
    assert rows[0]["min_input_tokens"] == 38_000
    assert rows[0]["cache_read_tokens"] == 0
    missing = json.loads(tools_by_name(fixture_db)["find_prefix"].invoke({"hash_prefix": "ffff"}))
    assert missing["match"] is None


def test_compare_periods_deltas(fixture_db: str) -> None:
    out = json.loads(
        tools_by_name(fixture_db)["compare_periods"].invoke(
            {"period_a": "2026-05-01:2026-05-10", "period_b": "2026-05-11:2026-05-20"}
        )
    )
    assert out["total_a_usd"] > 0
    assert out["delta_usd"] == round(out["total_b_usd"] - out["total_a_usd"], 2)


def test_top_sessions_growth_metric(fixture_db: str) -> None:
    rows = json.loads(tools_by_name(fixture_db)["top_sessions"].invoke({"metric": "growth", "limit": 5}))
    assert rows[0]["id"] == "sess_001"
    assert rows[0]["last_input_tokens"] == 59_400


def test_tool_responses_are_capped() -> None:
    huge = [{"row": i, "text": "x" * 200} for i in range(5_000)]
    out = capped_json(huge, max_tokens=2_000)
    assert len(out) <= 2_000 * 4
    parsed = json.loads(out)
    assert parsed["truncated"] is True

"""The six read-only tools both agents share, built over the SQLite export.

Plain functions with @tool decorators (LangChain 1.x pattern). Each returns
compact JSON capped at ~2,000 tokens (db.capped_json).
"""

from __future__ import annotations

from langchain_core.tools import BaseTool, tool

from .db import capped_json, connect_readonly, rows_to_dicts


def _date_clause(start: str, end: str) -> tuple[str, list[str]]:
    clauses, params = [], []
    if start:
        clauses.append("substr(timestamp,1,10) >= ?")
        params.append(start)
    if end:
        clauses.append("substr(timestamp,1,10) <= ?")
        params.append(end)
    return (" AND ".join(clauses) or "1=1", params)


def make_tools(db_path: str) -> list[BaseTool]:
    """Build the toolset bound to one database file."""

    @tool
    def spend_by_model(start: str = "", end: str = "") -> str:
        """Spend and request counts grouped by model, optionally restricted to
        an inclusive date range (YYYY-MM-DD). Use to see which models drive cost."""
        where, params = _date_clause(start, end)
        with connect_readonly(db_path) as conn:
            rows = conn.execute(
                f"""SELECT normalized_model AS model, ROUND(SUM(cost_usd),2) AS usd,
                           COUNT(*) AS requests, SUM(input_tokens) AS input_tokens,
                           SUM(output_tokens) AS output_tokens
                    FROM requests WHERE {where}
                    GROUP BY normalized_model ORDER BY usd DESC""",
                params,
            ).fetchall()
        return capped_json(rows_to_dicts(rows))

    @tool
    def spend_by_day(start: str = "", end: str = "") -> str:
        """Daily spend (USD) and request counts, optionally restricted to an
        inclusive date range (YYYY-MM-DD). Use to find spikes and trends."""
        clauses, params = [], []
        if start:
            clauses.append("date >= ?")
            params.append(start)
        if end:
            clauses.append("date <= ?")
            params.append(end)
        where = " AND ".join(clauses) or "1=1"
        with connect_readonly(db_path) as conn:
            rows = conn.execute(
                f"SELECT date, ROUND(usd,2) AS usd, requests FROM daily_spend WHERE {where} ORDER BY date",
                params,
            ).fetchall()
        return capped_json(rows_to_dicts(rows))

    @tool
    def top_sessions(metric: str = "cost", limit: int = 10) -> str:
        """Top sessions ranked by `metric`: "cost" (total USD), "growth"
        (last/first input-token ratio) or "turns". Use for context-bloat questions."""
        order = {
            "cost": "total_cost_usd DESC",
            "growth": "CAST(last_input_tokens AS REAL)/MAX(first_input_tokens,1) DESC",
            "turns": "turns DESC",
        }.get(metric, "total_cost_usd DESC")
        with connect_readonly(db_path) as conn:
            rows = conn.execute(
                f"""SELECT id, inferred, turns, first_ts, last_ts, first_input_tokens,
                           last_input_tokens, ROUND(total_cost_usd,2) AS total_cost_usd
                    FROM sessions ORDER BY {order} LIMIT ?""",
                [max(1, min(int(limit), 50))],
            ).fetchall()
        return capped_json(rows_to_dicts(rows))

    @tool
    def find_prefix(hash_prefix: str) -> str:
        """Look up a system-prompt hash prefix (e.g. "a3f9c2") and return the
        group's stats: occurrences, models, token sizes, caching status, cost."""
        with connect_readonly(db_path) as conn:
            rows = conn.execute(
                """SELECT system_prompt_hash, normalized_model AS model, COUNT(*) AS occurrences,
                          MIN(input_tokens) AS min_input_tokens, MAX(input_tokens) AS max_input_tokens,
                          SUM(cache_read_tokens) AS cache_read_tokens, ROUND(SUM(cost_usd),2) AS usd
                   FROM requests
                   WHERE system_prompt_hash LIKE ? || '%'
                   GROUP BY system_prompt_hash, normalized_model
                   ORDER BY occurrences DESC LIMIT 20""",
                [hash_prefix],
            ).fetchall()
        if not rows:
            return capped_json({"match": None, "note": f"no system_prompt_hash starts with {hash_prefix!r}"})
        return capped_json(rows_to_dicts(rows))

    @tool
    def compare_periods(period_a: str, period_b: str) -> str:
        """Compare spend between two inclusive date ranges, each formatted
        "YYYY-MM-DD:YYYY-MM-DD". Returns per-model totals for both and deltas."""

        def spend(period: str) -> dict[str, dict[str, float]]:
            start, _, end = period.partition(":")
            where, params = _date_clause(start.strip(), end.strip())
            with connect_readonly(db_path) as conn:
                rows = conn.execute(
                    f"""SELECT normalized_model AS model, ROUND(SUM(cost_usd),2) AS usd, COUNT(*) AS requests
                        FROM requests WHERE {where} GROUP BY normalized_model""",
                    params,
                ).fetchall()
            return {r["model"]: {"usd": r["usd"], "requests": r["requests"]} for r in rows}

        a, b = spend(period_a), spend(period_b)
        models = sorted(set(a) | set(b))
        out = []
        for m in models:
            ua, ub = a.get(m, {}).get("usd", 0.0), b.get(m, {}).get("usd", 0.0)
            out.append(
                {
                    "model": m,
                    "period_a_usd": ua,
                    "period_b_usd": ub,
                    "delta_usd": round(ub - ua, 2),
                }
            )
        total_a = round(sum(v["usd"] for v in a.values()), 2)
        total_b = round(sum(v["usd"] for v in b.values()), 2)
        return capped_json(
            {
                "period_a": period_a,
                "period_b": period_b,
                "total_a_usd": total_a,
                "total_b_usd": total_b,
                "delta_usd": round(total_b - total_a, 2),
                "by_model": out,
            }
        )

    @tool
    def get_findings() -> str:
        """The analyzers' findings from the audit: waste per cause, confidence,
        projected monthly savings, evidence. Start here for "why is X expensive"."""
        with connect_readonly(db_path) as conn:
            rows = conn.execute(
                """SELECT analyzer_id, name, ROUND(wasted_usd,2) AS wasted_usd,
                          ROUND(pct_of_total*100,1) AS pct_of_total_spend, confidence,
                          upper_bound, ROUND(projected_monthly_savings_usd,0) AS monthly_savings_usd,
                          evidence_json
                   FROM findings ORDER BY wasted_usd DESC"""
            ).fetchall()
        return capped_json(rows_to_dicts(rows))

    return [spend_by_model, spend_by_day, top_sessions, find_prefix, compare_periods, get_findings]

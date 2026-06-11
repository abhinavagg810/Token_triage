# TokenTriage SQLite export schema (v1)

`tokentriage analyze <path> --db audit.db` (or `tokentriage demo --db audit.db`)
exports the normalized analysis to a SQLite file. This is the integration
point between `core/` (writer) and `agent/` (reader). The export is a full
rewrite — the file is recreated on every run.

**Privacy:** the database contains hashes and token counts only. Prompt and
response bodies are never written (core invariant, PRD §5.2).

## Tables

### `meta`
Key/value pairs describing the export.

| key | value |
|---|---|
| `schema_version` | `1` |
| `generated_at` | ISO-8601 timestamp of the export |
| `period_start` / `period_end` | `YYYY-MM-DD` bounds of the dataset |
| `days_in_dataset` | integer, used for monthly extrapolation |
| `total_spend_usd` | total period spend |
| `addressable_waste_usd` | sum of findings |
| `request_count` | number of underlying requests |

### `requests`
One row per normalized request (canonical schema + derived columns).

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | |
| `timestamp` | TEXT | ISO-8601 |
| `ts` | INTEGER | epoch ms; NULL when unparsable |
| `provider` | TEXT | `anthropic` / `openai` / `other` |
| `model` | TEXT | raw model string from the log |
| `normalized_model` | TEXT | alias/date-suffix normalized |
| `service` | TEXT | from `metadata.service` or `metadata.agent`, else NULL |
| `input_tokens` … `cache_write_tokens` | INTEGER | token counts |
| `status` | INTEGER | HTTP status |
| `latency_ms` | INTEGER | |
| `session_id` | TEXT | explicit or inferred session, NULL if none |
| `system_prompt_hash` / `full_prompt_hash` | TEXT | SHA-256, NULL if unavailable |
| `max_tokens_set` | INTEGER | 0/1 |
| `cost_usd` | REAL | priced via active pricing table ($0 for unpriced models) |

Indexes: `ts`, `session_id`, `system_prompt_hash`.

### `sessions`
One row per reconstructed session (explicit or inferred).

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | `sess_*` (explicit) or `inferred_*` |
| `inferred` | INTEGER | 1 if heuristically reconstructed |
| `turns` | INTEGER | record count |
| `first_ts` / `last_ts` | TEXT | ISO-8601 |
| `first_input_tokens` / `last_input_tokens` | INTEGER | growth indicator |
| `total_cost_usd` | REAL | |

### `findings`
One row per analyzer that fired.

| column | type | notes |
|---|---|---|
| `analyzer_id` | TEXT PK | e.g. `cache-miss`, `retry-waste` |
| `name` | TEXT | human-readable |
| `wasted_usd` | REAL | |
| `pct_of_total` | REAL | fraction (0–1) of total spend |
| `confidence` | TEXT | `high` / `medium` / `low` |
| `upper_bound` | INTEGER | 1 → savings labelled "up to" |
| `projected_monthly_savings_usd` | REAL | |
| `evidence_json` | TEXT | JSON array of `{label, detail}` |
| `fix_json` | TEXT | JSON `{summary, steps[], snippet?, docs_url?}` |
| `details_json` | TEXT | analyzer-specific extras (e.g. worst sessions), NULL-able |

### `daily_spend`

| column | type |
|---|---|
| `date` | TEXT PK (`YYYY-MM-DD`) |
| `usd` | REAL |
| `requests` | INTEGER |

### `agent_runs`
Created empty by the exporter; **written by the agent service** so
TokenTriage audits its own token usage.

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | run id |
| `started_at` | TEXT | ISO-8601 |
| `kind` | TEXT | `ask` / `investigate` |
| `model` | TEXT | |
| `question` | TEXT | the user's question (not log content) |
| `input_tokens` / `output_tokens` / `cache_read_tokens` | INTEGER | summed over the run |
| `llm_calls` | INTEGER | |

## Versioning

`meta.schema_version` is bumped on breaking changes; the agent service checks
it on startup and refuses to run against an unknown version.

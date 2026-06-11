# TokenTriage

**Langfuse tells you what you spent. TokenTriage tells you why — and how to cut it.**

TokenTriage is an open-source CLI that explains **why** your LLM API bill is high, not just **what** was spent. Point it at your existing request logs (Helicone, Langfuse, OpenAI usage export, or a generic JSONL) and it produces a ranked diagnosis: each waste category with its share of total spend, projected monthly savings, and a concrete copy-paste fix.

```
TokenTriage — analyzed 10,133 requests · 1 May – 30 May 2026 (30 days)
Total spend: $919.70        Addressable waste found: $443.39 (48.2%)

 #   Cause                              Waste   % of spend   Monthly savings   Confidence
 1   Prompt caching not used          $257.92        28.0%           $258/mo         High
 2   Context bloat (agents)            $93.46        10.2%            $93/mo         High
 3   Retry/duplicate calls             $41.88         4.6%            $42/mo         High
 4   Model overkill                    $31.05         3.4%      up to $31/mo       Medium
 5   Verbose output (no max_tokens)    $19.08         2.1%            $19/mo          Low

Report written: ./tokentriage-report.html
```

It also writes a single self-contained HTML report — finding cards with evidence and copy-paste fixes, daily spend chart, model mix, worst sessions — that opens offline and is safe to share with whoever owns the budget.

## Quickstart

Try it on the bundled sample dataset (no data needed, works offline):

```bash
npx tokentriage demo
```

Run it on your own logs:

```bash
npx tokentriage analyze ./logs.jsonl
# or a directory of exports
npx tokentriage analyze ./exports/ --out report.html
```

Requires Node 18+. No install, no account, no backend.

## Privacy

TokenTriage is **fully local**:

- **No network calls.** Analysis runs entirely on your machine. The single exception is the opt-in `--narrate` flag, which sends *aggregated findings only* (never raw logs, never prompt content) to your own API key.
- **No prompt bodies are ever persisted.** If an export contains prompt/response bodies, TokenTriage computes SHA-256 hashes and lengths **in memory** and discards the bodies. They never reach disk, cache, or the report.
- **No telemetry.** None.

## Supported input formats

Format is auto-detected from the first 50 lines (`tokentriage formats` prints details):

| Format | Notes |
|---|---|
| **Generic JSONL** | The universal path — one canonical record per line (schema below) |
| **Helicone export** | CSV or JSONL request export |
| **Langfuse export** | JSON/JSONL/CSV of generations; `traceId` maps to sessions |
| **OpenAI usage CSV** | Aggregate only — spend trends + model mix; per-request analyzers are skipped with an explicit notice |

Canonical record schema (generic JSONL):

```json
{
  "id": "req_001",
  "timestamp": "2026-05-04T09:12:01Z",
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "input_tokens": 3120,
  "output_tokens": 410,
  "cache_read_tokens": 0,
  "cache_write_tokens": 0,
  "status": 200,
  "latency_ms": 2140,
  "session_id": "sess_91",
  "system_prompt_hash": "a3f9c2…",
  "full_prompt_hash": "7be1d0…",
  "max_tokens_set": true,
  "metadata": {}
}
```

Only `model`, `input_tokens`, `output_tokens`, and `timestamp` are required — everything else degrades gracefully (some analyzers need hashes or sessions to fire and will say so).

## What it detects

| Analyzer | What it catches | Confidence |
|---|---|---|
| **Cache miss** | The same system prompt sent ≥10× without prompt caching | High |
| **Context bloat** | Agent/chat sessions resending full history every turn | High |
| **Retry/duplicate waste** | Identical prompts re-fired within 60s, or retried verbatim after errors | High |
| **Model overkill** | Classification-shaped calls (tiny outputs) on frontier models | Medium, "up to" |
| **Verbose output** | Uncapped calls (no `max_tokens`) producing outlier-long outputs | Low |

A **claimed-token ledger** guarantees no token is counted by two analyzers, so the waste figures add up honestly. Every threshold and formula is documented in [`src/analyzers/THRESHOLDS.md`](src/analyzers/THRESHOLDS.md) — if one looks wrong for your workload, open a PR.

## CLI reference

| Command | Behavior |
|---|---|
| `tokentriage analyze <path> [--out report.html] [--json] [--narrate] [--no-session-inference] [--period 30d]` | Main flow |
| `tokentriage demo` | Runs on the bundled synthetic 30-day dataset |
| `tokentriage formats` | Supported input formats + canonical schema |
| `tokentriage pricing` | Active pricing table + override path |

`--json` emits machine-readable findings for CI (e.g. fail a pipeline if waste > 30%). `--narrate` adds an LLM-written executive summary to the report using your own key in `TOKENTRIAGE_LLM_KEY` — the only network call in the tool, off by default.

## Pricing data

Model prices ship in [`pricing.json`](pricing.json) with a `last_verified` date per entry (shown in the report footer). **Provider pricing changes frequently — verify figures against the provider pricing pages before relying on the dollar amounts.** Override or extend (e.g. negotiated rates, missing models) via `~/.tokentriage/pricing.override.json`; the override wins on conflict.

All savings figures are **estimates**, deliberately conservative: p75 baselines, "up to" labels on heuristic findings, cache-write overhead subtracted from caching savings.

## Development

```bash
npm install
npm test                  # vitest, per-analyzer fixture tests
npm run dev -- demo       # run the CLI from source
npm run generate-sample   # regenerate samples/sample-logs.jsonl
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) — pricing updates and new analyzers are the friendliest entry points.

## License

[MIT](LICENSE)

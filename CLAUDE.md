# TokenTriage — Project Instructions

## What this is
Open-source LLM token bill auditor. Ingests API request logs, runs deterministic
waste analyzers, outputs a diagnosis report (terminal + single-file HTML), plus a
LangGraph-based investigation/Q&A agent service. Full spec: PRD.md — it is the
source of truth. When this file and PRD.md conflict, PRD.md wins.

## Architecture (two services, one repo)
- `core/`  — TypeScript CLI: ingestion, analyzers, reports. NO LLM calls except
  the opt-in --narrate flag. All savings math must be deterministic and reproducible.
- `agent/` — Python 3.11 LangGraph service: investigation agent + spend Q&A agent.
  Reads the SQLite database exported by the core CLI (`--db`, schema in
  docs/db-schema.md). This is the ONLY place LangChain/LangGraph is used.

## Hard rules
1. TypeScript strict mode. Python with type hints + ruff.
2. LangChain: pin exact versions in agent/pyproject.toml. Use LangChain 1.x /
   LangGraph patterns ONLY: create_agent, StateGraph, tool decorators.
   NEVER use legacy patterns: LLMChain, initialize_agent, AgentExecutor,
   ConversationChain. If you are unsure whether a pattern is legacy, ask me.
3. Privacy: never write prompt/response bodies to disk, DB, or reports.
   Hashes and token counts only. No telemetry. No network calls except
   --narrate and the agent's own LLM calls (user's key via env var).
4. Every analyzer has unit tests with positive AND negative fixtures
   (logs that must trigger it, logs that must not).
5. Double-counting ledger: a token may be claimed by exactly one analyzer.
   Priority: retry-waste > cache-miss > dead-weight > context-bloat >
   model-overkill > verbose-output. (dead-weight is the A6 stretch analyzer —
   not yet implemented; the order holds for the implemented set.)
6. All user-facing copy (errors, warnings, report text) must match PRD.md §5.7
   exactly.
7. After completing any task: run the test suite, then run
   `npm run dev -- analyze samples/sample-logs.jsonl` (from core/) and paste
   the terminal output so I can verify the numbers.

## Commands
- core: `cd core && npm test` | `npm run dev -- <args>` | `npm run build` |
  `npm run generate-sample`
- agent: `cd agent && pytest` | `python -m agent.cli <args>`

## Definition of done for the whole project
`npx tokentriage demo` reproduces the Meridian Labs expected-findings table in
PRD.md §12.5 within ±10% (asserted in core/test/engine.test.ts), and the agent
answers "why was day 12 expensive?" correctly (retry storm) against the sample
database.

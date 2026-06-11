# PRD: TokenTriage — Open-Source LLM Token Bill Auditor (Phase 1: CLI Analyzer + HTML Report)

| Field | Detail |
|---|---|
| Name | **TokenTriage** — "triage" = diagnose, rank by severity, treat the worst first; exactly the product mechanic. (Runner-ups: BillSplain, TokenDoctor. Verify npm + GitHub availability for `tokentriage` before publishing.) |
| Target release | Phase 1 MVP by Sunday EOD; GitHub public launch the following week |

---

## 1. Overview

TokenTriage is an open-source tool that explains **why** an LLM API bill is high, not just **what** was spent. It ingests existing request logs (Helicone export, Langfuse export, OpenAI usage export, or a generic JSONL format), runs a set of rule-based analyzers, and produces a ranked diagnosis report: each waste category with its percentage of total spend, projected monthly savings, and a concrete, copy-paste fix.

**One-line positioning:** *"Langfuse tells you what you spent. TokenTriage tells you why — and how to cut it."*

Phase 1 is a CLI tool that outputs a terminal summary and a single self-contained HTML report. No hosted backend, no account, no data leaves the user's machine.

---

## 2. Problem Statement

1. LLM API costs are a top-3 operating cost for AI-native teams, and they are growing faster than teams understand them.
2. Existing observability tools (Helicone, Langfuse, LangSmith, Portkey) are excellent at **logging** — dashboards show spend by model, by day, by key — but they stop at description. They do not attribute spend to root causes or prescribe fixes.
3. The result: teams stare at a "$4,200 this month" number with no idea that 62% of it is a repeated 3K-token system prompt that prompt caching would cut by 90%.
4. The knowledge to fix this exists (caching, model routing, context management) but is scattered across provider docs and blog posts. Nobody connects a team's *own data* to the *specific fixes* that apply to them.

**Who feels this pain:** developers and small teams running LLM features or agent systems in production; indie hackers watching API spend eat margins; PMs/founders asked "why is our OpenAI bill ₹4L this month?"

---

## 3. Goals & Non-Goals

### 3.1 Goals (Phase 1)

| # | Goal | Success signal |
|---|---|---|
| G1 | A user with an existing Helicone/Langfuse/OpenAI export gets a full diagnosis report in under 5 minutes with one command | Time-to-report < 5 min in self-test |
| G2 | Report attributes ≥ 70% of addressable waste to named causes with % and $ figures | Validated against Castler agent-platform logs |
| G3 | Every finding ships with a concrete fix including a code snippet where applicable | 100% of analyzers have a `fix` block |
| G4 | Fully local: no network calls (except optional LLM narrative with user's own key), no telemetry | Verifiable in code; stated in README |
| G5 | Demo-able without user data via bundled sample dataset | `npx tokentriage demo` works offline |

### 3.2 Non-Goals (Phase 1)

- No live proxy / real-time capture (Phase 3).
- No hosted dashboard or web app (Phase 2).
- No prompt-content storage or semantic analysis of prompt text beyond hashing and length (privacy-first; also keeps scope sane).
- No monetization, billing, accounts, or auth — ever, per project intent (open source, MIT license).
- No support for fine-tuning, embeddings, image, or audio costs in v1 (text completions only).

---

## 4. Users & Personas

| Persona | Context | Primary need |
|---|---|---|
| **Dev with observability already set up** (primary) | Has weeks/months of Helicone or Langfuse data | "Tell me what to fix, ranked by savings" |
| **Dev with no logging** | Uses OpenAI/Anthropic directly | Can export OpenAI usage CSV (aggregate) for a partial report; full value needs Phase 3 proxy — v1 should degrade gracefully and say so |
| **Agent builder** | Running multi-agent loops (LangGraph, Claude Agent SDK) | Context-bloat and retry analyzers are the hero features; sessions matter |
| **Tech lead / PM** | Owns the budget conversation | The HTML report — shareable, plain English, ₹/$ figures |

---

## 5. Scope — Functional Requirements

### 5.1 FR-1: Log Ingestion

The CLI accepts an input file (or directory) and auto-detects the format.

**Supported input formats (v1):**

| Format | Detection | Notes |
|---|---|---|
| Generic JSONL (canonical schema, §5.2) | `.jsonl` + schema match | Documented in README as the universal path |
| Helicone CSV/JSONL export | Header/field signature (`helicone-id`, `request_body`, etc.) | Map to canonical schema |
| Langfuse export (JSON/CSV of generations) | Field signature (`traceId`, `usage.promptTokens`, etc.) | Map traces → sessions |
| OpenAI usage export (CSV) | Header signature | **Aggregate only** — enables spend trends + model-mix analysis; per-request analyzers are skipped with an explicit notice |

**Step-by-step flow:**

1. User runs `tokentriage analyze ./logs.jsonl` (or a directory: all matching files are concatenated).
2. CLI sniffs the first 50 lines to detect format. If ambiguous → error E-101 (§5.7) listing supported formats and a link to the schema doc.
3. Each record is mapped to the canonical schema. Records that fail mapping are skipped and counted; if > 10% of records are skipped, show warning W-201 with the top 3 missing fields.
4. Records are sorted by timestamp; sessions are reconstructed (§5.3).
5. Pricing is joined from `pricing.json` (§5.4). Records with unknown models are priced at $0 and listed in the report's "Unpriced models" footnote with instructions to add them to a local pricing override file.

**Validations:**

- Empty file / zero valid records → error E-102.
- Fewer than 50 valid records → proceed, but the report header shows banner: *"Small sample (N=37). Findings are directional, not conclusive."*
- Timestamps unparsable on > 5% of records → session reconstruction disabled; session-dependent analyzers (context bloat, retry waste) are skipped with notice in report.

### 5.2 Canonical Record Schema

Every input format is normalized to:

```json
{
  "id": "string",
  "timestamp": "ISO-8601",
  "provider": "anthropic | openai | other",
  "model": "string",
  "input_tokens": 0,
  "output_tokens": 0,
  "cache_read_tokens": 0,
  "cache_write_tokens": 0,
  "status": 200,
  "latency_ms": 0,
  "session_id": "string | null",
  "system_prompt_hash": "sha256 | null",
  "full_prompt_hash": "sha256 | null",
  "max_tokens_set": true,
  "metadata": {}
}
```

**Privacy rule (hard requirement):** if a source export contains prompt/response bodies, TokenTriage computes hashes and lengths **in memory** and never writes bodies to disk, cache, or report. State this in README and code comments; it is a core trust property of the project.

### 5.3 Session Reconstruction

Needed because the highest-value analyzers (context bloat, retries) operate on conversations, not single calls.

- If `session_id` / `traceId` exists in source → use it.
- Else, heuristic grouping: same `system_prompt_hash` + monotonically increasing `input_tokens` + inter-call gap < 30 minutes → same session.
- Edge cases: parallel sessions with identical system prompts may merge incorrectly — acceptable in v1; report footnote discloses the heuristic. A `--no-session-inference` flag disables it.

### 5.4 Pricing Table

- `pricing.json` ships in the repo: `{ "anthropic": { "claude-sonnet-4-5": { "input_per_mtok": 3.00, "output_per_mtok": 15.00, "cache_read_per_mtok": 0.30, "cache_write_per_mtok": 3.75 }, ... } }`
- **Action before launch:** verify every figure against current provider pricing pages; pricing changes frequently and wrong math destroys credibility. Add `last_verified` date per entry, displayed in the report footer.
- Users can override/extend via `~/.tokentriage/pricing.override.json` (e.g., negotiated enterprise rates). Override wins on conflict.
- Model-name normalization map (e.g., `gpt-4o-2024-11-20` → `gpt-4o`) maintained in the same file. This is the easiest community-contribution surface — call it out in CONTRIBUTING.md.

### 5.5 FR-2: Analyzer Engine (the core product)

Common interface — every analyzer is a module exporting:

```ts
interface Analyzer {
  id: string;                    // "cache-miss"
  name: string;                  // "Prompt caching not used"
  detect(records, sessions, pricing): Finding | null;
}
interface Finding {
  wasted_usd: number;            // estimated addressable waste in the analyzed period
  pct_of_total: number;          // wasted_usd / total_spend
  confidence: "high" | "medium" | "low";
  evidence: EvidenceItem[];      // top examples: hashes, counts, token figures
  fix: { summary: string; steps: string[]; snippet?: string; docs_url?: string };
  projected_monthly_savings_usd: number;  // extrapolated from period length
}
```

**v1 analyzer set (build in this order; A1–A4 are the weekend must-haves):**

| # | Analyzer | Detection logic | Waste formula | Fix prescribed | Confidence rules |
|---|---|---|---|---|---|
| A1 | **Cache miss** | Same `system_prompt_hash` in ≥ 10 calls AND `cache_read_tokens == 0` across them AND provider supports caching | For each repeated prefix: `(occurrences − 1) × prefix_tokens × (input_price − cache_read_price)` ; prefix_tokens estimated as the stable minimum input across the group when prompt bodies unavailable | Enable prompt caching; snippet for Anthropic `cache_control` and note on OpenAI automatic caching; show per-prefix savings table | High if hashes available; Medium if estimated from token patterns |
| A2 | **Context bloat** | Within a session, `input_tokens` grows monotonically and final/first ratio > 3×, session length ≥ 5 turns | Tokens above a sliding-window baseline (default: window = first-turn input + 2× median new-content-per-turn) × input price | Sliding window or summarize-after-K-turns; pseudo-code snippet; show worst 5 sessions with growth curves (sparkline in HTML) | High |
| A3 | **Model overkill** | Calls on frontier-tier models where `output_tokens < 150` AND input < 2K AND no tool use — pattern typical of classification/extraction | `Σ (frontier_cost − budget_model_cost)` for matching calls, using cheapest same-provider tier | Route matched call-shapes to Haiku / 4o-mini; flag that quality must be validated — label savings "up to" | Medium (heuristic; never claim certainty about task complexity) |
| A4 | **Retry / duplicate waste** | (a) `full_prompt_hash` repeats within 60s; (b) status ≥ 400 followed by identical hash | Full cost of all-but-first occurrence | Idempotency key / response cache for (a); exponential backoff + trimmed retry context for (b) | High |
| A5 | **Verbose output** | `max_tokens_set == false` AND output_tokens > p90 for that model across dataset | `(output_tokens − p75) × output_price` summed over matches | Set `max_tokens`; add brevity instruction; snippet | Low–Medium |
| A6 | **Dead-weight prompt** (stretch) | Stable token block present at start of every call in a group (inferred from minimum common input size) that is *not* cached | Same math as A1 applied to the static block | Restructure: static prefix (cached) + dynamic suffix | Low |

**Cross-cutting rules:**

- Double-counting guard: a token can be claimed by only one analyzer. Priority order: A4 → A1 → A6 → A2 → A3 → A5 (waste from a retried call shouldn't also count as a cache miss). Implement as a claimed-token ledger per record.
- Percentages in the report are of **total spend**, and the report explicitly separates "addressable waste" (sum of findings) from "base spend".
- Extrapolation: `projected_monthly_savings = wasted_usd × (30 / days_in_dataset)`, shown with the period it was derived from.
- Every formula and threshold lives in `analyzers/THRESHOLDS.md` — full transparency is the OSS trust strategy and invites tuning PRs.

### 5.6 FR-3: Outputs

**Terminal summary (always):**

```
TokenTriage — analyzed 48,211 requests · 14 Mar – 10 Jun 2026 (89 days)
Total spend: $6,412.80        Addressable waste found: $2,894.10 (45.1%)

 #  Cause                       Waste      % of spend   Monthly savings   Confidence
 1  Prompt caching not used     $1,802.40    28.1%        $607/mo          High
 2  Context bloat (agents)        $643.20    10.0%        $217/mo          High
 3  Retry/duplicate calls         $268.50     4.2%         $90/mo          High
 4  Model overkill                $180.00     2.8%      up to $61/mo       Medium

Run opened: ./tokentriage-report.html
```

**HTML report (single self-contained file, no CDN, inline CSS/JS):**

1. **Header strip** — period, request count, total spend, waste %, big "potential monthly savings" number. This section is the screenshot for README/LinkedIn — design it to be share-worthy.
2. **"Why your bill is high"** — ranked finding cards. Each card: name, % bar, $ figures, confidence badge, 2–3 evidence rows (e.g., "Largest of 4 uncached prefixes: `a3f9…` sent 14,202× · ~2,940 tokens · $111 wasted"), expandable fix with copy button on the snippet.
3. **Spend overview** — daily spend line, model-mix donut, input-vs-output split. (Lightweight inline SVG; no charting library if possible.)
4. **Worst sessions table** (when sessions exist) — top 10 by waste, with growth sparkline.
5. **Footnotes** — unpriced models, skipped records, pricing `last_verified` dates, methodology link.

**Optional LLM narrative (`--narrate`):** sends *aggregated findings only* (never raw logs) to the user's own Anthropic/OpenAI key (`TOKENTRIAGE_LLM_KEY` env var) to generate a 3-paragraph executive summary embedded at the top of the report. Off by default; clearly documented as the only network call in the tool.

**Other outputs:** `--json` flag emits machine-readable findings (CI usage, e.g., fail a pipeline if waste > 30%) — trivial to add, high perceived sophistication.

### 5.7 CLI Spec, Errors & Messages

**Commands:**

| Command | Behavior |
|---|---|
| `tokentriage analyze <path> [--out report.html] [--json] [--narrate] [--no-session-inference] [--period 30d]` | Main flow |
| `tokentriage demo` | Runs on bundled `samples/sample-logs.jsonl` (synthetic 30-day dataset engineered so every analyzer fires) |
| `tokentriage formats` | Prints supported input formats + canonical schema |
| `tokentriage pricing` | Prints active pricing table + override path |

**Error/warning copy (exact messages):**

| Code | Message |
|---|---|
| E-101 | `Could not detect log format. Supported: generic JSONL, Helicone export, Langfuse export, OpenAI usage CSV. See: tokentriage formats` |
| E-102 | `No valid records found in <path>. Check the file isn't empty and matches a supported format.` |
| W-201 | `Skipped 1,204 of 9,800 records (12%) — missing fields: input_tokens, model. Findings may understate waste.` |
| W-202 | `OpenAI usage export is aggregate-only. Per-request analyzers (caching, context bloat, retries) were skipped. For full diagnosis, export from Helicone/Langfuse or use the generic JSONL schema.` |
| W-203 | `3 models had no pricing data and were costed at $0: <list>. Add them to ~/.tokentriage/pricing.override.json` |

---

## 6. Non-Functional Requirements

| Area | Requirement |
|---|---|
| Performance | 1M records analyzed in < 60s on a laptop; stream-parse JSONL, never load bodies into memory |
| Privacy | No prompt bodies persisted; no telemetry; no network calls except opt-in `--narrate`; document in README "Privacy" section |
| Portability | Node 18+ ; runs via `npx tokentriage` with zero install; single-file HTML output opens offline |
| Licensing | MIT |
| Code quality | TypeScript, strict mode; each analyzer unit-tested against fixture logs that should and shouldn't trigger it |

**Stack decision:** TypeScript/Node over Python — `npx` gives a zero-install demo path (better for GitHub traction), and the HTML report shares code with a future Phase 2 Next.js dashboard. (Python would widen the data-science audience; revisit at Phase 2 if demanded.)

---

## 7. Repo Structure

```
tokentriage/
├── README.md                 # hero screenshot, npx quickstart, privacy section
├── CONTRIBUTING.md           # analyzer plugin guide, pricing.json updates
├── LICENSE                   # MIT
├── pricing.json
├── samples/sample-logs.jsonl
├── src/
│   ├── cli.ts
│   ├── ingest/               # detect.ts, helicone.ts, langfuse.ts, openai-usage.ts, jsonl.ts
│   ├── core/                 # schema.ts, sessions.ts, pricing.ts, ledger.ts (double-count guard)
│   ├── analyzers/            # cache-miss.ts, context-bloat.ts, model-overkill.ts, retry-waste.ts,
│   │                         # verbose-output.ts, THRESHOLDS.md
│   ├── report/               # html.ts (template), terminal.ts, json.ts, narrative.ts
│   └── index.ts
└── test/                     # fixtures/ + per-analyzer tests
```

---

## 8. Weekend Build Plan (Claude Code–driven)

Total: ~16–18 focused hours. Each block below is sized to be one or two Claude Code sessions with a clear definition of done. Build order is chosen so there is a working end-to-end "walking skeleton" by Friday night.

### Friday evening (3 hrs) — Skeleton end-to-end

| Time | Task | Done when |
|---|---|---|
| 1.0h | Scaffold repo: TS config, CLI entry (commander), canonical schema, generic JSONL ingest, pricing.json with 8–10 models | `tokentriage analyze sample.jsonl` prints total spend |
| 1.0h | Generate `samples/sample-logs.jsonl` — synthetic 30-day, ~5K-record dataset with deliberate waste patterns baked in (repeated system prompt, one bloated agent session, retries, frontier-model classification calls). *Write the generator script; keep it in `scripts/` — it doubles as test fixtures.* | Every A1–A4 pattern present in sample |
| 1.0h | Analyzer interface + claimed-token ledger + A4 retry-waste (simplest analyzer) wired into terminal output | Demo prints first ranked finding |

### Saturday (7–8 hrs) — The analyzers

| Time | Task | Done when |
|---|---|---|
| 2.0h | A1 cache-miss: grouping by system_prompt_hash, prefix-token estimation, savings math, fix snippet (Anthropic cache_control example) | Fires correctly on sample + unit test |
| 2.0h | A2 context bloat: session reconstruction (§5.3) + growth detection + baseline math | Worst-sessions list correct on sample |
| 1.5h | A3 model overkill + A5 verbose output | Both fire on sample; A3 labeled "up to" |
| 1.5h | Terminal report polish (table, colors) + `--json` output + W/E error messages from §5.7 | All copy matches PRD |
| 1.0h | **Real-data validation:** run on Castler agent-platform logs (export from your existing logging). Tune thresholds where findings look wrong. This hour matters more than any feature — it's your G2 check | Findings pass your own sniff test |

### Sunday (6–7 hrs) — Report, ingest adapters, launch prep

| Time | Task | Done when |
|---|---|---|
| 2.5h | HTML report: single-file template, header strip, finding cards with % bars + copyable snippets, inline-SVG daily spend line, footnotes | Opens offline, looks screenshot-worthy |
| 1.5h | Helicone + Langfuse adapters (map exports → canonical schema); OpenAI usage CSV adapter with W-202 degradation | Each adapter has a fixture test |
| 0.5h | `tokentriage demo` command + `--narrate` (optional; cut if behind schedule) | `npx tokentriage demo` works offline |
| 1.5h | README (hero screenshot from sample report, quickstart, privacy section, "how detection works" link to THRESHOLDS.md), CONTRIBUTING.md, MIT license | A stranger can run the demo in < 2 min |
| 0.5h | Publish: GitHub repo (private until launch post ready), `npm publish` dry-run | Tag v0.1.0 |

**Scope-cut order if running behind (cut from the bottom):** `--narrate` → A5 → Langfuse adapter → OpenAI CSV adapter. Never cut: A1, A2, sample dataset, HTML report, README.

**Claude Code working tips for this build:** keep this PRD in the repo root as `PRD.md` and reference it in CLAUDE.md; build one analyzer per session with its test fixture in the same prompt; ask Claude Code to run the sample after every analyzer and paste the terminal output back for verification.

### Next week (post-weekend, not in scope but plan now)

- Mon–Tue: verify pricing.json against live provider pages; fix figures; set `last_verified`.
- Wed: LinkedIn launch post + Show HN draft ("I built an open-source tool that explains *why* your LLM bill is high").
- Launch with the sample-report screenshot as the hero image.

---

## 9. Success Metrics (post-launch, 30 days)

| Metric | Target |
|---|---|
| GitHub stars | 200+ |
| `npx tokentriage demo` runs (npm downloads as proxy) | 500+ |
| External issues/PRs (esp. pricing.json + new analyzers) | 5+ |
| Documented user finding > $100/mo savings (testimonial/issue) | 1+ |

---

## 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Wrong savings math (pricing drift, bad formulas) | Credibility-fatal | `last_verified` dates; THRESHOLDS.md transparency; "estimate" language everywhere; conservative formulas (p75 baselines, "up to" labels) |
| Export formats change (Helicone/Langfuse) | Adapters break | Generic JSONL is the documented canonical path; adapters are convenience |
| Findings feel obvious to sophisticated users | Low perceived value | Evidence specificity is the antidote — exact prefixes, counts, per-session curves, not generic advice |
| Hash unavailability in some exports (no prompt bodies) | A1/A6 degrade | Token-pattern estimation fallback with Medium confidence label |
| Incumbents copy the idea | Inevitable | Fine — it's OSS; speed + community + being the canonical "auditor" name is the moat |

---

## 11. Open Questions

1. Final name + npm package availability check (do before Friday — renaming after launch is painful).
2. Should sessions support Claude Agent SDK trace format natively in v1? (You have the test data; if the Langfuse adapter covers it, skip.)
3. Currency display: USD only in v1, or detect locale and show ₹ conversion? (Recommend USD-only v1; ₹ toggle is a nice first community issue to file yourself.)

---

## 12. Appendix: Worked Examples

These examples define expected behavior end-to-end. They double as acceptance tests — the bundled sample dataset should reproduce numbers in this ballpark.

### 12.1 Example input — canonical JSONL records

Three records from one agent session (note the growing `input_tokens` — this is what A2 detects — and the repeated `system_prompt_hash` with zero cache reads — what A1 detects):

```json
{"id":"req_001","timestamp":"2026-05-04T09:12:01Z","provider":"anthropic","model":"claude-sonnet-4-5","input_tokens":3120,"output_tokens":410,"cache_read_tokens":0,"cache_write_tokens":0,"status":200,"latency_ms":2140,"session_id":"sess_91","system_prompt_hash":"a3f9c2…","full_prompt_hash":"7be1d0…","max_tokens_set":true,"metadata":{"agent":"hr-agent"}}
{"id":"req_002","timestamp":"2026-05-04T09:12:18Z","provider":"anthropic","model":"claude-sonnet-4-5","input_tokens":7480,"output_tokens":520,"cache_read_tokens":0,"cache_write_tokens":0,"status":200,"latency_ms":3010,"session_id":"sess_91","system_prompt_hash":"a3f9c2…","full_prompt_hash":"c44a91…","max_tokens_set":true,"metadata":{"agent":"hr-agent"}}
{"id":"req_003","timestamp":"2026-05-04T09:12:44Z","provider":"anthropic","model":"claude-sonnet-4-5","input_tokens":13950,"output_tokens":480,"cache_read_tokens":0,"cache_write_tokens":0,"status":200,"latency_ms":4380,"session_id":"sess_91","system_prompt_hash":"a3f9c2…","full_prompt_hash":"e9d27f…","max_tokens_set":true,"metadata":{"agent":"hr-agent"}}
```

### 12.2 Example finding — A1 Cache Miss, full math worked through

**Observed in dataset (standalone 30-day illustration, total spend $395):**

- System prompt prefix `a3f9c2…` (~2,940 tokens, estimated as the stable minimum input across the group)
- Sent in 14,202 calls on `claude-sonnet-4-5`, `cache_read_tokens = 0` on all of them
- Pricing: input $3.00/MTok, cache read $0.30/MTok, cache write $3.75/MTok

**Waste calculation:**

| Step | Math | Result |
|---|---|---|
| Tokens re-sent uncached | (14,202 − 1) × 2,940 tokens | 41.75 MTok |
| Cost as paid (full input price) | 41.75 MTok × $3.00/MTok | $125.26 |
| Cost if cached (reads) | 41.75 MTok × $0.30/MTok | $12.53 |
| Cache-write overhead (assume re-write every 100 calls due to 5-min TTL) | 142 × 2,940 tokens × $3.75/MTok | $1.57 |
| **Estimated waste** | $125.26 − $12.53 − $1.57 | **$111.16 over 30 days** |

**Rendered finding card (exact copy):**

> **#1 · Prompt caching not used — $111.16 (28.1% of $395 spend) · Confidence: High**
> The same 2,940-token system prompt (`a3f9c2…`) was sent 14,202 times without caching. With Anthropic prompt caching, repeat sends cost 10% of the input price.
> **Projected savings: ~$111/month** · [Show fix ▾]

### 12.3 Example fix snippets (shipped inside finding cards, copy-button enabled)

**A1 — Anthropic prompt caching:**

```python
response = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    system=[{
        "type": "text",
        "text": LONG_SYSTEM_PROMPT,          # your 2,940-token prefix
        "cache_control": {"type": "ephemeral"}  # <-- this line is the fix
    }],
    messages=messages,
)
```

*Note for OpenAI users: caching is automatic for prompts ≥ 1,024 tokens — the fix is restructuring so the static part comes first (see A6).*

**A2 — Context bloat, sliding window:**

```python
MAX_HISTORY_TURNS = 8

def build_messages(history, new_msg):
    recent = history[-MAX_HISTORY_TURNS:]
    if len(history) > MAX_HISTORY_TURNS:
        recent = [summary_message(history[:-MAX_HISTORY_TURNS])] + recent
    return recent + [new_msg]
```

**A4 — Retry waste, exponential backoff with idempotency:**

```python
@retry(wait=wait_exponential(min=1, max=30), stop=stop_after_attempt(4))
def call_llm(payload):
    # cache identical payload hashes for 60s to kill duplicate fires
    key = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    if cached := response_cache.get(key):
        return cached
    ...
```

### 12.4 Example `--narrate` output (LLM-generated executive summary)

> *Your team spent $6,413 over the last 89 days, and about 45% of it was avoidable. The single biggest driver is a large system prompt sent uncached on every call — fixing this one line saves roughly $607/month. The second driver is your HR agent: its conversations resend the full history every turn, with some sessions ballooning from 3K to 14K input tokens in under a minute. A sliding-window history would cut another ~$217/month. Everything else is small. Implement the top two fixes and your bill drops by about a third.*

### 12.5 Example end-to-end scenario (the bundled sample dataset's "story")

The synthetic `samples/sample-logs.jsonl` simulates **"Meridian Labs"**, a 4-dev team running a support copilot + an agent pipeline for 30 days (~5K requests, ~$940 spend). Baked-in waste, with expected analyzer results:

| Baked-in pattern | Analyzer that must fire | Expected finding (±10%) |
|---|---|---|
| 2.1K-token system prompt on every copilot call, never cached | A1 | ~$264 waste, ~28% |
| Agent sessions averaging 11 turns, full history resent | A2 | ~$94 waste, ~10% |
| Sentiment classification (40-token outputs) running on a frontier model | A3 | ~$31, "up to" label |
| A bug window on day 12: 3× duplicate fires within seconds for 6 hours | A4 | ~$39, evidence pinpoints day 12 |
| One service with no max_tokens, rambling outputs | A5 | ~$18, Low–Medium confidence |

`npx tokentriage demo` must reproduce this table. It is also the screenshot used in the README and launch post.

---

*Implementation note: the bundled sample dataset matches this table's dollar figures and percentages; hitting them at ~5K records is not arithmetically possible with current pricing, so the dataset uses ~10K records (the spend story and percentages take precedence — see `scripts/generate-sample.ts`).*

# Analyzer thresholds & formulas

Every detection threshold and waste formula in TokenTriage, in one place.
Full transparency is the point: if a threshold looks wrong for your workload,
open a PR — these are starting points, not laws.

All analyzers share a **claimed-token ledger**: a token can be claimed by only
one analyzer. Run order is the priority order — **A4 retry → A1 cache-miss →
A2 context-bloat → A3 model-overkill → A5 verbose-output** — so waste from a
retried call is never also counted as a cache miss, and so on.

Percentages in the report are of **total spend**. Monthly projections are
`wasted_usd × (30 / days_in_dataset)`, always shown alongside the period they
were derived from.

---

## A4 — Retry / duplicate waste (`retry-waste`)

**Detection**
- (a) the same `full_prompt_hash` appears again within **60 s** of the previous
  send, or
- (b) a response with `status >= 400` is followed by a call with an identical
  `full_prompt_hash` (any gap).

**Waste** — the full cost (input + output) of every occurrence after the
first. These tokens are claimed entirely.

**Confidence** — High. Identical hashes in a tight window are unambiguous.

## A1 — Cache miss (`cache-miss`)

**Detection** — the same `system_prompt_hash` (per model) appears in
**≥ 10 calls**, `cache_read_tokens == 0` on all of them, and the provider
supports prompt caching.

**Prefix estimation** — `prefix_tokens = min(input_tokens)` across the group
(the stable minimum is the shared prefix; prompt bodies are never read).

**Waste**

```
gross   = (occurrences − 1) × prefix_tokens × (input_price − cache_read_price)
rewrite = ceil(occurrences / 100) × prefix_tokens × cache_write_price
waste   = gross − rewrite
```

The rewrite term conservatively assumes the cache is re-written every
100 calls (5-minute TTL churn).

**Confidence** — High when real hashes are available; Medium if estimated
from token patterns only.

## A2 — Context bloat (`context-bloat`)

**Detection** — within a session: length **≥ 5 turns** and
`last_input / first_input > 3×`.

**Baseline** — `first_turn_input + 2 × median(per-turn input growth)`.
This approximates what a sliding-window strategy would have sent.

**Waste** — `Σ max(0, input_tokens − baseline) × input_price` over the
session's turns (unclaimed tokens only).

**Confidence** — High.

## A3 — Model overkill (`model-overkill`)

**Detection** — calls on **frontier-tier** models (see `tier` in
`pricing.json`) with `output_tokens < 150` AND `input_tokens < 2,000` AND no
tool use — the shape of classification/extraction work.

**Waste** — `Σ (frontier_cost − cheapest_budget_model_cost)` for matching
calls, using the cheapest budget-tier model from the same provider.

**Confidence** — Medium, and savings are always labelled **"up to"**: token
counts cannot prove a task is simple. Validate quality before routing down.

## A5 — Verbose output (`verbose-output`)

**Detection** — `max_tokens_set == false` AND `output_tokens > p90` for that
model across the dataset.

**Waste** — `Σ (output_tokens − p75) × output_price` over matches. Using p75
as the baseline keeps the estimate conservative.

**Confidence** — Low. Long outputs are sometimes exactly what you wanted.

---

## Session reconstruction

- Explicit `session_id` / `traceId` is always used when present.
- Otherwise (unless `--no-session-inference`): records with the same
  `system_prompt_hash`, non-decreasing `input_tokens`, and an inter-call gap
  **< 30 minutes** are grouped into one inferred session.
- Known limitation: parallel sessions with identical system prompts may merge.
  The report footnote discloses when inference was used.

# Using TokenTriage — individual, team, and enterprise workflows

TokenTriage is fully local at every tier: logs are analyzed on your machine,
the database contains hashes and token counts (never prompt content), and the
only network calls are the opt-in `--narrate` flag and the agent's own LLM
calls with your key.

## Individual developer — "why is my bill $200 this month?"

One-off diagnosis, five minutes:

```bash
# export your logs from Helicone/Langfuse (or write generic JSONL), then:
npx tokentriage analyze ./logs.jsonl
open tokentriage-report.html
```

The terminal shows the ranked waste table; the HTML report has the evidence
and copy-paste fixes (e.g. the exact `cache_control` block to add). Apply the
top fix, re-export logs a few days later, run again, watch the finding shrink.

No logging set up yet? Start with your provider's aggregate usage CSV
(`tokentriage analyze usage.csv`) for spend trends and model mix — the report
will tell you which per-request analyzers were skipped and why.

## Team — weekly audit + dashboard

```bash
# 1. analyze and export the queryable database
tokentriage analyze ./exports/ --db audit.db --out report.html

# 2. share report.html in Slack (it's one file, opens offline, no secrets in it)

# 3. explore interactively
tokentriage serve --db audit.db        # → http://127.0.0.1:4117
```

The dashboard answers the follow-up questions the static report can't:
filter spend by service/model/date, page through individual requests, rank
sessions by cost or growth. The `service` attribution comes from
`metadata.service` (or `metadata.agent`) in your logs — tag your call sites
and per-team cost attribution falls out for free.

Ask questions in plain English with the agent service:

```bash
cd agent && pip install -e . && export ANTHROPIC_API_KEY=...
python -m agent.cli --db ../audit.db ask "which service grew the most last week?"
python -m agent.cli --db ../audit.db investigate --date 2026-05-12
```

## CI — stop waste from regressing

`--json` makes findings machine-readable. Fail a pipeline when addressable
waste crosses a threshold:

```yaml
# .github/workflows/token-audit.yml (scheduled or on demand)
- run: npx tokentriage analyze ./logs.jsonl --json > findings.json
- run: |
    PCT=$(jq '.addressable_waste_pct' findings.json)
    echo "Addressable waste: ${PCT}%"
    awk "BEGIN{exit !($PCT > 30)}" && { echo "::error::waste >30%"; exit 1; } || true
```

## Enterprise

The properties that matter for security review, and how to operate at scale:

**Data boundary.** TokenTriage never phones home: no telemetry, no account,
no hosted backend. Prompt/response bodies in source exports are hashed
(SHA-256) in memory and discarded — they never reach disk, the report, the
SQLite export, or the dashboard. The two opt-in network paths (`--narrate`,
agent LLM calls) send aggregated findings / database query results to *your*
API key; both are off unless you invoke them. This is auditable in the code
and asserted by tests (`core/test/narrative.test.ts`, `core/test/db.test.ts`,
`core/test/serve.test.ts`). Air-gapped use works: `npm pack` the tarball,
install offline, everything runs without egress.

**Recommended deployment.**

1. **Scheduled audit job** (cron/Airflow/GitHub Actions on a runner inside
   your VPC): export the last 30 days from your observability stack →
   `tokentriage analyze logs.jsonl --db /srv/tokentriage/audit.db --out report.html`.
2. **Dashboard for FinOps/platform teams**: `tokentriage serve --db audit.db`
   on an internal host (bind stays on 127.0.0.1 by default; front it with
   your own reverse proxy + SSO if you expose it beyond localhost — the
   server itself deliberately ships no auth because it ships no remote access).
3. **Cost attribution**: standardize a `metadata.service` tag in your LLM
   gateway/middleware so every request carries its owning team — the
   dashboard and `--json` output then break spend and waste down by service.
4. **Negotiated rates**: enterprise contracts rarely match list prices. Drop
   your real rates into `~/.tokentriage/pricing.override.json` (same shape as
   `core/pricing.json`) on the audit host; overrides win on conflict, and the
   report footer records pricing provenance.
5. **Regression gate**: the CI recipe above, run against each product's logs,
   keeps "we fixed caching" fixed.
6. **FinOps Q&A**: the agent service answers "why did spend jump on the 12th"
   grounded in the database, and logs its own token usage to `agent_runs` —
   the auditor's cost is itself audited.

**What enterprises typically find first** (from the analyzer set): an
uncached system prompt on the highest-volume service (often 20–30% of spend),
agent pipelines resending full history every turn, and classification
workloads running on frontier models. The report's evidence is specific
enough (prefix hashes, counts, per-session growth curves) to hand straight
to the owning team as a ticket.

## Reading the numbers honestly

Every figure is an estimate and labelled as such: percentages are of total
spend, heuristic findings say "up to", monthly projections state the period
they extrapolate from, and a claimed-token ledger guarantees no token is
counted by two analyzers. Formulas and thresholds live in
[`core/src/analyzers/THRESHOLDS.md`](../core/src/analyzers/THRESHOLDS.md);
if one is wrong for your workload, override it with a PR — that transparency
is the product's trust model.

import type { Analyzer, AnalyzerContext, Finding, EvidenceItem } from "./types.js";
import { projectMonthly } from "./types.js";

const MIN_OCCURRENCES = 10; // same system_prompt_hash in >= 10 calls
const CACHE_REWRITE_EVERY = 100; // assume cache re-write every N calls (5-min TTL churn)

/**
 * A1 — Cache miss: a repeated system prompt sent without prompt caching.
 * Detection: same system_prompt_hash in >= 10 calls AND cache_read_tokens == 0
 * across them AND the provider supports caching.
 * Waste per group: (occurrences − 1) × prefix_tokens × (input_price − cache_read_price)
 * minus a conservative cache-write overhead. prefix_tokens is estimated as the
 * stable minimum input across the group (prompt bodies are never read).
 */
export const cacheMiss: Analyzer = {
  id: "cache-miss",
  name: "Prompt caching not used",
  detect(ctx: AnalyzerContext): Finding | null {
    const groups = new Map<string, typeof ctx.records>();
    for (const r of ctx.records) {
      if (!r.system_prompt_hash || r.aggregate) continue;
      const price = ctx.pricing.lookup(r.provider, r.model);
      if (!price || price.supports_caching === false) continue;
      // Group key includes the model: prefix tokens & prices differ per model.
      const key = `${r.system_prompt_hash}::${r.provider}::${ctx.pricing.normalize(r.model)}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }

    interface GroupResult {
      hash: string;
      model: string;
      occurrences: number;
      prefixTokens: number;
      wasted: number;
    }
    const results: GroupResult[] = [];
    let totalWasted = 0;

    for (const records of groups.values()) {
      if (records.length < MIN_OCCURRENCES) continue;
      if (records.some((r) => r.cache_read_tokens > 0)) continue; // caching already in use

      const first = records[0]!;
      const price = ctx.pricing.lookup(first.provider, first.model)!;
      // Stable minimum input across the group ≈ the shared prefix size.
      const prefixTokens = Math.min(...records.map((r) => r.input_tokens));
      if (prefixTokens <= 0) continue;

      // Claim prefix tokens on every occurrence after the first; the ledger
      // caps claims at what retry-waste hasn't already taken.
      let claimedTotal = 0;
      for (let i = 1; i < records.length; i++) {
        claimedTotal += ctx.ledger.claimInput(records[i]!, prefixTokens);
      }
      if (claimedTotal === 0) continue;

      const grossSaving = (claimedTotal * (price.input_per_mtok - price.cache_read_per_mtok)) / 1_000_000;
      const rewrites = Math.ceil(records.length / CACHE_REWRITE_EVERY);
      const writeOverhead = (rewrites * prefixTokens * price.cache_write_per_mtok) / 1_000_000;
      const wasted = Math.max(0, grossSaving - writeOverhead);
      if (wasted < 0.01) continue;

      totalWasted += wasted;
      results.push({
        hash: first.system_prompt_hash!,
        model: ctx.pricing.normalize(first.model),
        occurrences: records.length,
        prefixTokens,
        wasted,
      });
    }

    if (results.length === 0 || totalWasted < 0.01) return null;
    results.sort((a, b) => b.wasted - a.wasted);

    // Confidence: High when real hashes were available (they were, since we
    // grouped on them). Medium would apply to token-pattern estimation only.
    const evidence: EvidenceItem[] = results.slice(0, 3).map((g, i) => ({
      label: `Prefix ${i + 1} of ${results.length}`,
      detail: `\`${g.hash.slice(0, 6)}…\` sent ${g.occurrences.toLocaleString()}× on ${g.model} · ~${g.prefixTokens.toLocaleString()} tokens · $${g.wasted.toFixed(2)} wasted`,
    }));

    return {
      analyzer_id: "cache-miss",
      analyzer_name: "Prompt caching not used",
      wasted_usd: totalWasted,
      pct_of_total: ctx.totalSpend > 0 ? totalWasted / ctx.totalSpend : 0,
      confidence: "high",
      evidence,
      fix: {
        summary:
          "Enable prompt caching on the repeated prefix. On Anthropic, add cache_control to the static system block; on OpenAI, caching is automatic for prompts ≥ 1,024 tokens — make sure the static part comes first.",
        steps: [
          "Move all static content (system prompt, few-shot examples, docs) to the front of the request.",
          "Anthropic: mark the static block with cache_control (snippet below). Repeat reads cost 10% of input price.",
          "OpenAI: caching is automatic for prompts ≥ 1,024 tokens once the static prefix is byte-stable — avoid timestamps or per-request IDs inside it.",
          "Verify cache_read_tokens > 0 in your logs after deploying.",
        ],
        snippet: `response = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    system=[{
        "type": "text",
        "text": LONG_SYSTEM_PROMPT,          # your repeated prefix
        "cache_control": {"type": "ephemeral"}  # <-- this line is the fix
    }],
    messages=messages,
)`,
        snippet_lang: "python",
        docs_url: "https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching",
      },
      projected_monthly_savings_usd: projectMonthly(totalWasted, ctx.daysInDataset),
      details: {
        prefixes: results.map((g) => ({
          hash: g.hash.slice(0, 8),
          model: g.model,
          occurrences: g.occurrences,
          prefix_tokens: g.prefixTokens,
          wasted_usd: round2(g.wasted),
        })),
      },
    };
  },
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

import type { Analyzer, AnalyzerContext, Finding, EvidenceItem } from "./types.js";
import { projectMonthly } from "./types.js";

const MIN_OCCURRENCES = 20;
const MIN_BLOCK_TOKENS = 5_000; // only flag blocks big enough to matter
const FLOOR_STABILITY_RATIO = 1.3; // p25 must sit close to the floor

/**
 * A6 — Dead-weight prompt (stretch): a large stable token block at the start
 * of every call in a group that is NOT cached — inferred purely from token
 * patterns when no system_prompt_hash is available (hashed groups belong to
 * A1 cache-miss, which runs first).
 *
 * Grouping: provider + model + service tag (metadata.service/agent). A group
 * qualifies when it has >= 20 calls, zero cache reads, an input floor of
 * >= 5,000 tokens, and a "flat" floor (p25 <= 1.3 × min) — the signature of a
 * static block plus a smaller variable suffix.
 *
 * Waste: same math as A1 applied to the inferred block. Confidence is Low by
 * construction — token floors can also come from genuinely variable payloads,
 * which is why the savings use the conservative minimum and the fix says to
 * verify the block exists before restructuring.
 */
export const deadWeight: Analyzer = {
  id: "dead-weight",
  name: "Dead-weight prompt (uncached static block)",
  detect(ctx: AnalyzerContext): Finding | null {
    const groups = new Map<string, typeof ctx.records>();
    for (const r of ctx.records) {
      if (r.system_prompt_hash || r.aggregate) continue; // hashed groups are A1's domain
      const price = ctx.pricing.lookup(r.provider, r.model);
      if (!price || price.supports_caching === false) continue;
      const service =
        typeof r.metadata["service"] === "string"
          ? (r.metadata["service"] as string)
          : typeof r.metadata["agent"] === "string"
            ? (r.metadata["agent"] as string)
            : "(unattributed)";
      const key = `${r.provider}::${ctx.pricing.normalize(r.model)}::${service}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }

    interface GroupResult {
      key: string;
      occurrences: number;
      blockTokens: number;
      wasted: number;
    }
    const results: GroupResult[] = [];
    let totalWasted = 0;

    for (const [key, records] of groups) {
      if (records.length < MIN_OCCURRENCES) continue;
      if (records.some((r) => r.cache_read_tokens > 0)) continue;

      const inputs = records.map((r) => r.input_tokens).sort((a, b) => a - b);
      const floor = inputs[0]!;
      if (floor < MIN_BLOCK_TOKENS) continue;
      const p25 = inputs[Math.floor(inputs.length * 0.25)]!;
      if (p25 > floor * FLOOR_STABILITY_RATIO) continue; // floor is an outlier, not a block

      const first = records[0]!;
      const price = ctx.pricing.lookup(first.provider, first.model)!;

      let claimedTotal = 0;
      for (let i = 1; i < records.length; i++) {
        claimedTotal += ctx.ledger.claimInput(records[i]!, floor);
      }
      if (claimedTotal === 0) continue;

      const grossSaving = (claimedTotal * (price.input_per_mtok - price.cache_read_per_mtok)) / 1_000_000;
      const rewrites = Math.ceil(records.length / 100);
      const writeOverhead = (rewrites * floor * price.cache_write_per_mtok) / 1_000_000;
      const wasted = Math.max(0, grossSaving - writeOverhead);
      if (wasted < 0.01) continue;

      totalWasted += wasted;
      results.push({ key, occurrences: records.length, blockTokens: floor, wasted });
    }

    if (results.length === 0 || totalWasted < 0.01) return null;
    results.sort((a, b) => b.wasted - a.wasted);

    const evidence: EvidenceItem[] = results.slice(0, 3).map((g) => {
      const [, model, service] = g.key.split("::");
      return {
        label: service === "(unattributed)" ? model! : `${service}`,
        detail: `inferred static block of ~${g.blockTokens.toLocaleString()} tokens sent ${g.occurrences.toLocaleString()}× uncached on ${model} · $${g.wasted.toFixed(2)} wasted (if the block is truly static)`,
      };
    });

    return {
      analyzer_id: "dead-weight",
      analyzer_name: "Dead-weight prompt (uncached static block)",
      wasted_usd: totalWasted,
      pct_of_total: ctx.totalSpend > 0 ? totalWasted / ctx.totalSpend : 0,
      confidence: "low",
      evidence,
      fix: {
        summary:
          "These calls share a large input floor with no caching — the signature of a static block (instructions, schemas, reference docs) resent on every call. Verify the block exists, then restructure: static prefix (cached) + dynamic suffix.",
        steps: [
          "Inspect one request from the group and confirm a large static block at the start (this analyzer only sees token counts, so verify before acting).",
          "Move all static content to the front of the request, byte-stable across calls.",
          "Anthropic: mark it with cache_control. OpenAI: automatic for prompts ≥ 1,024 tokens once the prefix is stable.",
          "Re-run TokenTriage and confirm the group now shows cache_read_tokens > 0.",
        ],
        snippet: `# Before: instructions + document interleaved per call
# After: stable prefix first, dynamic content last
response = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    system=[{
        "type": "text",
        "text": STATIC_INSTRUCTIONS_AND_REFERENCE,   # the inferred block
        "cache_control": {"type": "ephemeral"},
    }],
    messages=[{"role": "user", "content": dynamic_payload}],
)`,
        snippet_lang: "python",
      },
      projected_monthly_savings_usd: projectMonthly(totalWasted, ctx.daysInDataset),
      details: {
        groups: results.map((g) => ({
          group: g.key,
          occurrences: g.occurrences,
          inferred_block_tokens: g.blockTokens,
          wasted_usd: Math.round(g.wasted * 100) / 100,
        })),
      },
    };
  },
};

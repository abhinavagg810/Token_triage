import type { Analyzer, AnalyzerContext, Finding } from "./types.js";
import { projectMonthly } from "./types.js";

/**
 * A5 — Verbose output: calls with no max_tokens cap whose outputs exceed the
 * p90 for that model across the dataset.
 * Waste: (output_tokens − p75) × output_price summed over matches.
 * Low–Medium confidence: long outputs are sometimes legitimately needed.
 */
export const verboseOutput: Analyzer = {
  id: "verbose-output",
  name: "Verbose output (no max_tokens)",
  detect(ctx: AnalyzerContext): Finding | null {
    // Percentiles per normalized model across the whole dataset.
    const outputsByModel = new Map<string, number[]>();
    for (const r of ctx.records) {
      if (r.aggregate) continue;
      const key = ctx.pricing.normalize(r.model);
      const list = outputsByModel.get(key) ?? [];
      list.push(r.output_tokens);
      outputsByModel.set(key, list);
    }
    const p90ByModel = new Map<string, number>();
    const p75ByModel = new Map<string, number>();
    for (const [model, outputs] of outputsByModel) {
      outputs.sort((a, b) => a - b);
      p90ByModel.set(model, percentileSorted(outputs, 0.9));
      p75ByModel.set(model, percentileSorted(outputs, 0.75));
    }

    let wasted = 0;
    let matched = 0;
    let worst: { model: string; output: number } | null = null;

    for (const r of ctx.records) {
      if (r.aggregate || r.max_tokens_set) continue;
      const key = ctx.pricing.normalize(r.model);
      const p90 = p90ByModel.get(key) ?? 0;
      const p75 = p75ByModel.get(key) ?? 0;
      if (r.output_tokens <= p90) continue;
      const price = ctx.pricing.lookup(r.provider, r.model);
      if (!price) continue;

      const claimed = ctx.ledger.claimOutput(r, r.output_tokens - p75);
      if (claimed === 0) continue;
      wasted += (claimed * price.output_per_mtok) / 1_000_000;
      matched++;
      if (!worst || r.output_tokens > worst.output) worst = { model: key, output: r.output_tokens };
    }

    if (wasted < 0.01 || matched === 0) return null;

    return {
      analyzer_id: "verbose-output",
      analyzer_name: "Verbose output (no max_tokens)",
      wasted_usd: wasted,
      pct_of_total: ctx.totalSpend > 0 ? wasted / ctx.totalSpend : 0,
      confidence: "low",
      evidence: [
        {
          label: "Uncapped calls",
          detail: `${matched.toLocaleString()} calls with no max_tokens produced outputs above the p90 for their model`,
        },
        ...(worst
          ? [
              {
                label: "Worst offender",
                detail: `A ${worst.model} call produced ${worst.output.toLocaleString()} output tokens with no cap set`,
              },
            ]
          : []),
      ],
      fix: {
        summary:
          "Set max_tokens on every call and add a brevity instruction where long-form output isn't the point.",
        steps: [
          "Set max_tokens to a sensible ceiling per call site (p95 of legitimate outputs is a good default).",
          'Add an explicit length instruction to the prompt, e.g. "Answer in at most 3 sentences."',
          "Long outputs also cost latency — capping usually improves UX too.",
        ],
        snippet: `response = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=800,   # <-- cap it; was previously unset
    system=SYSTEM_PROMPT + "\\nBe concise: answer in at most 3 sentences.",
    messages=messages,
)`,
        snippet_lang: "python",
      },
      projected_monthly_savings_usd: projectMonthly(wasted, ctx.daysInDataset),
    };
  },
};

function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

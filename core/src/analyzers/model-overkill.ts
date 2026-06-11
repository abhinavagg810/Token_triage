import type { Analyzer, AnalyzerContext, Finding } from "./types.js";
import { projectMonthly } from "./types.js";

const MAX_OUTPUT_TOKENS = 150; // short outputs typical of classification/extraction
const MAX_INPUT_TOKENS = 2_000;

/**
 * A3 — Model overkill: classification/extraction-shaped calls (tiny output,
 * small input, no tool use) running on frontier-tier models.
 * Waste: Σ (frontier_cost − cheapest_budget_model_cost) for matching calls.
 * Medium confidence and "up to" labelling — we cannot know task complexity
 * from token counts alone; quality must be validated before routing down.
 */
export const modelOverkill: Analyzer = {
  id: "model-overkill",
  name: "Model overkill",
  detect(ctx: AnalyzerContext): Finding | null {
    let wasted = 0;
    let matched = 0;
    const byModel = new Map<string, { calls: number; wasted: number; route: string }>();

    for (const r of ctx.records) {
      if (r.aggregate) continue;
      if (r.output_tokens >= MAX_OUTPUT_TOKENS || r.input_tokens >= MAX_INPUT_TOKENS) continue;
      if (hasToolUse(r.metadata)) continue;
      const price = ctx.pricing.lookup(r.provider, r.model);
      if (!price || price.tier !== "frontier") continue;
      const budget = ctx.pricing.cheapestBudget(r.provider);
      if (!budget) continue;

      const inTok = ctx.ledger.availableInput(r);
      const outTok = ctx.ledger.availableOutput(r);
      if (inTok === 0 && outTok === 0) continue;
      ctx.ledger.claimInput(r, inTok);
      ctx.ledger.claimOutput(r, outTok);

      const diff =
        (inTok * (price.input_per_mtok - budget.price.input_per_mtok) +
          outTok * (price.output_per_mtok - budget.price.output_per_mtok)) /
        1_000_000;
      if (diff <= 0) continue;
      wasted += diff;
      matched++;
      const key = ctx.pricing.normalize(r.model);
      const entry = byModel.get(key) ?? { calls: 0, wasted: 0, route: budget.model };
      entry.calls++;
      entry.wasted += diff;
      byModel.set(key, entry);
    }

    if (wasted < 0.01 || matched === 0) return null;

    const topModels = [...byModel.entries()].sort((a, b) => b[1].wasted - a[1].wasted);

    return {
      analyzer_id: "model-overkill",
      analyzer_name: "Model overkill",
      wasted_usd: wasted,
      pct_of_total: ctx.totalSpend > 0 ? wasted / ctx.totalSpend : 0,
      confidence: "medium",
      upper_bound: true, // never claim certainty about task complexity
      evidence: topModels.slice(0, 3).map(([model, e]) => ({
        label: model,
        detail: `${e.calls.toLocaleString()} short calls (<${MAX_OUTPUT_TOKENS} output tokens) — routing to ${e.route} would save up to $${e.wasted.toFixed(2)}`,
      })),
      fix: {
        summary:
          "Route classification/extraction-shaped calls to a budget-tier model (Haiku, gpt-4o-mini). Validate quality on a sample before switching — savings are an upper bound.",
        steps: [
          "Identify the call sites producing these short outputs (classification, extraction, routing decisions).",
          "Run a side-by-side eval on ~100 samples with the budget model.",
          "If quality holds, switch the model parameter for those call sites only.",
        ],
        snippet: `# Route by task shape instead of one model for everything
def pick_model(task_type: str) -> str:
    if task_type in {"classify", "extract", "route"}:
        return "claude-haiku-4-5"      # or "gpt-4o-mini"
    return "claude-sonnet-4-5"`,
        snippet_lang: "python",
      },
      projected_monthly_savings_usd: projectMonthly(wasted, ctx.daysInDataset),
    };
  },
};

function hasToolUse(metadata: Record<string, unknown>): boolean {
  return Boolean(metadata["tools"] || metadata["tool_use"] || metadata["tool_calls"]);
}

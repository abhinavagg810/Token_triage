import type { AnalysisResult } from "../core/engine.js";

/** Machine-readable findings for CI usage (e.g. fail a pipeline if waste > 30%). */
export function renderJson(result: AnalysisResult): string {
  const wastePct = result.totalSpend > 0 ? result.addressableWaste / result.totalSpend : 0;
  return JSON.stringify(
    {
      tool: "tokentriage",
      version: 1,
      period: {
        start: result.periodStart,
        end: result.periodEnd,
        days: result.daysInDataset,
      },
      requests: result.requestCount,
      total_spend_usd: round(result.totalSpend),
      addressable_waste_usd: round(result.addressableWaste),
      addressable_waste_pct: round(wastePct * 100),
      small_sample: result.smallSample,
      aggregate_only: result.aggregateOnly,
      findings: result.findings.map((f) => ({
        id: f.analyzer_id,
        name: f.analyzer_name,
        wasted_usd: round(f.wasted_usd),
        pct_of_total: round(f.pct_of_total * 100),
        confidence: f.confidence,
        upper_bound: f.upper_bound ?? false,
        projected_monthly_savings_usd: round(f.projected_monthly_savings_usd),
        evidence: f.evidence,
        fix: f.fix,
        details: f.details ?? null,
      })),
      model_spend: result.modelSpend.map((m) => ({ ...m, usd: round(m.usd) })),
      unpriced_models: result.unpricedModels,
      warnings: result.warnings,
    },
    null,
    2
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

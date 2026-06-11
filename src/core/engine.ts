import type { CanonicalRecord, Session, SkipStats } from "./schema.js";
import { PricingTable } from "./pricing.js";
import { reconstructSessions } from "./sessions.js";
import { TokenLedger } from "./ledger.js";
import { ANALYZERS, SESSION_DEPENDENT, type Finding } from "../analyzers/index.js";

export interface Warning {
  code: string;
  message: string;
}

export interface DailySpend {
  date: string; // YYYY-MM-DD
  usd: number;
}

export interface ModelSpend {
  model: string;
  usd: number;
  requests: number;
}

export interface AnalysisResult {
  records: CanonicalRecord[];
  sessions: Session[];
  findings: Finding[];
  totalSpend: number;
  addressableWaste: number;
  requestCount: number;
  periodStart: string;
  periodEnd: string;
  daysInDataset: number;
  dailySpend: DailySpend[];
  modelSpend: ModelSpend[];
  inputCost: number;
  outputCost: number;
  cacheCost: number;
  unpricedModels: string[];
  warnings: Warning[];
  smallSample: boolean;
  aggregateOnly: boolean;
  sessionInferenceUsed: boolean;
  sessionsDisabledByTimestamps: boolean;
  skippedAnalyzers: string[];
  pricingLastVerified: string | null;
  overridePath: string;
}

export interface AnalyzeOptions {
  sessionInference?: boolean; // default true
  periodDays?: number | null; // restrict to most recent N days
}

export function analyze(
  records: CanonicalRecord[],
  pricing: PricingTable,
  skips: SkipStats,
  options: AnalyzeOptions = {}
): AnalysisResult {
  const warnings: Warning[] = [];

  // W-201: >10% of records skipped during ingest.
  if (skips.total > 0 && skips.skipped / skips.total > 0.1) {
    const topFields = [...skips.missingFields.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([f]) => f)
      .join(", ");
    warnings.push({
      code: "W-201",
      message: `Skipped ${skips.skipped.toLocaleString()} of ${skips.total.toLocaleString()} records (${Math.round((skips.skipped / skips.total) * 100)}%) — missing fields: ${topFields}. Findings may understate waste.`,
    });
  }

  // Optional --period filter: most recent N days relative to the newest record.
  let working = records;
  if (options.periodDays && options.periodDays > 0) {
    const maxTs = Math.max(...records.map((r) => (Number.isNaN(r.ts) ? -Infinity : r.ts)));
    if (Number.isFinite(maxTs)) {
      const cutoff = maxTs - options.periodDays * 86_400_000;
      working = records.filter((r) => Number.isNaN(r.ts) || r.ts >= cutoff);
    }
  }

  const aggregateOnly = working.length > 0 && working.every((r) => r.aggregate);
  if (aggregateOnly) {
    warnings.push({
      code: "W-202",
      message:
        "OpenAI usage export is aggregate-only. Per-request analyzers (caching, context bloat, retries) were skipped. For full diagnosis, export from Helicone/Langfuse or use the generic JSONL schema.",
    });
  }

  // Timestamps unparsable on > 5% → session reconstruction disabled (PRD §5.1).
  const badTs = working.filter((r) => Number.isNaN(r.ts)).length;
  const sessionsDisabledByTimestamps = working.length > 0 && badTs / working.length > 0.05;

  // Spend
  let totalSpend = 0;
  let inputCost = 0;
  let outputCost = 0;
  let cacheCost = 0;
  const daily = new Map<string, number>();
  const byModel = new Map<string, { usd: number; requests: number }>();
  for (const r of working) {
    const price = pricing.lookup(r.provider, r.model);
    const cost = pricing.cost(r);
    totalSpend += cost;
    if (price) {
      inputCost += (r.input_tokens * price.input_per_mtok) / 1_000_000;
      outputCost += (r.output_tokens * price.output_per_mtok) / 1_000_000;
      cacheCost +=
        (r.cache_read_tokens * price.cache_read_per_mtok +
          r.cache_write_tokens * price.cache_write_per_mtok) /
        1_000_000;
    }
    const day = r.timestamp.slice(0, 10);
    if (day) daily.set(day, (daily.get(day) ?? 0) + cost);
    const modelKey = pricing.normalize(r.model);
    const entry = byModel.get(modelKey) ?? { usd: 0, requests: 0 };
    entry.usd += cost;
    entry.requests += r.n_requests ?? 1;
    byModel.set(modelKey, entry);
  }

  const validTs = working.map((r) => r.ts).filter((t) => !Number.isNaN(t));
  const minTs = validTs.length ? Math.min(...validTs) : NaN;
  const maxTs = validTs.length ? Math.max(...validTs) : NaN;
  const daysInDataset = Number.isNaN(minTs)
    ? 30
    : Math.max(1, Math.ceil((maxTs - minTs) / 86_400_000));

  // Sessions
  const sessionInference = (options.sessionInference ?? true) && !sessionsDisabledByTimestamps;
  const sessions =
    sessionsDisabledByTimestamps || aggregateOnly
      ? []
      : reconstructSessions(working, { inference: sessionInference });

  // Analyzers — run order is ledger priority; a token is claimed once.
  const ledger = new TokenLedger();
  const findings: Finding[] = [];
  const skippedAnalyzers: string[] = [];
  for (const analyzer of ANALYZERS) {
    if (aggregateOnly) {
      skippedAnalyzers.push(analyzer.name);
      continue;
    }
    if (sessionsDisabledByTimestamps && SESSION_DEPENDENT.has(analyzer.id)) {
      skippedAnalyzers.push(analyzer.name);
      continue;
    }
    const finding = analyzer.detect({
      records: working,
      sessions,
      pricing,
      ledger,
      totalSpend,
      daysInDataset,
    });
    if (finding) findings.push(finding);
  }
  findings.sort((a, b) => b.wasted_usd - a.wasted_usd);

  // W-203: unpriced models costed at $0.
  if (pricing.unpriced.size > 0) {
    const list = [...pricing.unpriced].join(", ");
    warnings.push({
      code: "W-203",
      message: `${pricing.unpriced.size} model${pricing.unpriced.size === 1 ? "" : "s"} had no pricing data and ${pricing.unpriced.size === 1 ? "was" : "were"} costed at $0: ${list}. Add them to ~/.tokentriage/pricing.override.json`,
    });
  }

  const requestCount = working.reduce((acc, r) => acc + (r.n_requests ?? 1), 0);

  // Latest last_verified across the active pricing table, for the report footer.
  let pricingLastVerified: string | null = null;
  for (const models of Object.values(pricing.models)) {
    for (const p of Object.values(models)) {
      if (p.last_verified && (!pricingLastVerified || p.last_verified > pricingLastVerified)) {
        pricingLastVerified = p.last_verified;
      }
    }
  }

  return {
    records: working,
    sessions,
    findings,
    totalSpend,
    addressableWaste: findings.reduce((acc, f) => acc + f.wasted_usd, 0),
    requestCount,
    periodStart: Number.isNaN(minTs) ? "unknown" : new Date(minTs).toISOString().slice(0, 10),
    periodEnd: Number.isNaN(maxTs) ? "unknown" : new Date(maxTs).toISOString().slice(0, 10),
    daysInDataset,
    dailySpend: [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, usd]) => ({ date, usd })),
    modelSpend: [...byModel.entries()]
      .map(([model, e]) => ({ model, usd: e.usd, requests: e.requests }))
      .sort((a, b) => b.usd - a.usd),
    inputCost,
    outputCost,
    cacheCost,
    unpricedModels: [...pricing.unpriced],
    warnings,
    smallSample: requestCount < 50,
    aggregateOnly,
    sessionInferenceUsed: sessionInference && sessions.some((s) => s.inferred),
    sessionsDisabledByTimestamps,
    skippedAnalyzers,
    pricingLastVerified,
    overridePath: pricing.overridePath,
  };
}

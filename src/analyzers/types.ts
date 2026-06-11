import type { CanonicalRecord, Session } from "../core/schema.js";
import type { PricingTable } from "../core/pricing.js";
import type { TokenLedger } from "../core/ledger.js";

export interface EvidenceItem {
  label: string;
  detail: string;
}

export interface Fix {
  summary: string;
  steps: string[];
  snippet?: string;
  snippet_lang?: string;
  docs_url?: string;
}

export interface Finding {
  analyzer_id: string;
  analyzer_name: string;
  wasted_usd: number;
  pct_of_total: number;
  confidence: "high" | "medium" | "low";
  /** When true, render savings as "up to $X" (heuristic detection, e.g. model overkill). */
  upper_bound?: boolean;
  evidence: EvidenceItem[];
  fix: Fix;
  projected_monthly_savings_usd: number;
  /** Analyzer-specific extras surfaced in the HTML report (e.g. worst sessions). */
  details?: Record<string, unknown>;
}

export interface AnalyzerContext {
  records: CanonicalRecord[];
  sessions: Session[];
  pricing: PricingTable;
  ledger: TokenLedger;
  totalSpend: number;
  daysInDataset: number;
}

export interface Analyzer {
  id: string;
  name: string;
  detect(ctx: AnalyzerContext): Finding | null;
}

export function projectMonthly(wastedUsd: number, daysInDataset: number): number {
  if (daysInDataset <= 0) return wastedUsd;
  return wastedUsd * (30 / daysInDataset);
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalRecord } from "../src/core/schema.js";
import { PricingTable, type PricingFile } from "../src/core/pricing.js";
import { TokenLedger } from "../src/core/ledger.js";
import { reconstructSessions } from "../src/core/sessions.js";
import type { AnalyzerContext } from "../src/analyzers/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function testPricing(): PricingTable {
  const base = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "pricing.json"), "utf-8")
  ) as PricingFile;
  return new PricingTable(base);
}

let counter = 0;

/** Build a canonical record with sensible defaults; override what the test needs. */
export function rec(overrides: Partial<CanonicalRecord> = {}): CanonicalRecord {
  const ts = overrides.ts ?? Date.UTC(2026, 4, 1, 12, 0, 0) + counter * 120_000;
  counter++;
  return {
    id: overrides.id ?? `t_${counter}`,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    input_tokens: 1000,
    output_tokens: 300,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    status: 200,
    latency_ms: 1000,
    session_id: null,
    system_prompt_hash: null,
    full_prompt_hash: null,
    max_tokens_set: true,
    metadata: {},
    ...overrides,
    ts: overrides.ts ?? ts,
    timestamp: overrides.timestamp ?? new Date(ts).toISOString(),
  };
}

export function ctx(records: CanonicalRecord[], overrides: Partial<AnalyzerContext> = {}): AnalyzerContext {
  const pricing = overrides.pricing ?? testPricing();
  const totalSpend = records.reduce((acc, r) => acc + pricing.cost(r), 0);
  return {
    records,
    sessions: reconstructSessions(records),
    pricing,
    ledger: new TokenLedger(),
    totalSpend,
    daysInDataset: 30,
    ...overrides,
  };
}

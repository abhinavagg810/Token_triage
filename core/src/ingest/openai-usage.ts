import type { CanonicalRecord, SkipStats } from "../core/schema.js";
import { parseTimestamp } from "../core/schema.js";
import { parseCsv } from "./csv.js";

/**
 * OpenAI usage export (CSV) adapter — AGGREGATE ONLY (PRD §5.1).
 * Each row represents many requests bucketed by day/model. Per-request
 * analyzers are skipped by the engine when it sees aggregate records (W-202);
 * spend trends and model-mix analysis still work.
 */
export function ingestOpenAiUsage(text: string): { records: CanonicalRecord[]; skips: SkipStats } {
  const skips: SkipStats = { total: 0, skipped: 0, missingFields: new Map() };
  const records: CanonicalRecord[] = [];
  const { rows } = parseCsv(text);

  let index = 0;
  for (const row of rows) {
    skips.total++;
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) lower[k.toLowerCase().trim()] = v;

    const model = lower["model"] || lower["snapshot_id"] || "";
    if (!model) {
      skips.skipped++;
      bump(skips, "model");
      continue;
    }
    const input = num(lower["n_context_tokens_total"] ?? lower["input_tokens"] ?? lower["n_prompt_tokens_total"]);
    if (input === null) {
      skips.skipped++;
      bump(skips, "input_tokens");
      continue;
    }
    const output = num(lower["n_generated_tokens_total"] ?? lower["output_tokens"] ?? lower["n_completion_tokens_total"]) ?? 0;
    const tsRaw = lower["date"] ?? lower["timestamp"] ?? lower["aggregation_timestamp"];
    if (!tsRaw) {
      skips.skipped++;
      bump(skips, "timestamp");
      continue;
    }
    const { iso, ts } = parseTimestamp(/^\d+$/.test(tsRaw) ? Number(tsRaw) : tsRaw);

    records.push({
      id: `usage_${index}`,
      timestamp: iso,
      ts,
      provider: "openai",
      model,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: num(lower["n_cached_context_tokens_total"]) ?? 0,
      cache_write_tokens: 0,
      status: 200,
      latency_ms: 0,
      session_id: null,
      system_prompt_hash: null,
      full_prompt_hash: null,
      max_tokens_set: true,
      metadata: {},
      aggregate: true,
      n_requests: num(lower["n_requests"]) ?? 1,
    });
    index++;
  }

  return { records, skips };
}

function bump(skips: SkipStats, field: string): void {
  skips.missingFields.set(field, (skips.missingFields.get(field) ?? 0) + 1);
}

function num(v: string | undefined): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

import type { CanonicalRecord, SkipStats } from "../core/schema.js";
import { inferProvider, parseTimestamp } from "../core/schema.js";
import { parseCsv } from "./csv.js";
import { hashRequestBody, sha256 } from "./hash.js";

/**
 * Helicone export adapter (CSV or JSONL). Maps Helicone request rows to the
 * canonical schema. If request bodies are present they are hashed in memory
 * and discarded (privacy rule, PRD §5.2).
 */
export function ingestHelicone(text: string): { records: CanonicalRecord[]; skips: SkipStats } {
  const skips: SkipStats = { total: 0, skipped: 0, missingFields: new Map() };
  const records: CanonicalRecord[] = [];

  const firstChar = text.trimStart()[0];
  const rawRows: Record<string, unknown>[] = [];
  if (firstChar === "{" || firstChar === "[") {
    if (firstChar === "[") {
      try {
        for (const row of JSON.parse(text) as Record<string, unknown>[]) rawRows.push(row);
      } catch {
        /* fall through to JSONL */
      }
    }
    if (rawRows.length === 0) {
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === "") continue;
        try {
          rawRows.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          skips.total++;
          skips.skipped++;
          bump(skips, "(unparsable JSON)");
        }
      }
    }
  } else {
    for (const row of parseCsv(text).rows) rawRows.push(row);
  }

  let index = 0;
  for (const row of rawRows) {
    skips.total++;
    const get = (...keys: string[]): unknown => {
      for (const k of keys) {
        if (row[k] !== undefined && row[k] !== "") return row[k];
      }
      return undefined;
    };

    const model = str(get("model", "request_model", "response_model", "model_override"));
    if (!model) {
      skips.skipped++;
      bump(skips, "model");
      continue;
    }
    const inputTokens = num(get("prompt_tokens", "promptTokens", "input_tokens"));
    if (inputTokens === null) {
      skips.skipped++;
      bump(skips, "input_tokens");
      continue;
    }
    const outputTokens = num(get("completion_tokens", "completionTokens", "output_tokens")) ?? 0;
    const tsRaw = get("request_created_at", "created_at", "createdAt", "time", "timestamp");
    if (tsRaw === undefined) {
      skips.skipped++;
      bump(skips, "timestamp");
      continue;
    }
    const { iso, ts } = parseTimestamp(tsRaw);

    // Hash bodies in memory if present; never persisted.
    let body: unknown = get("request_body", "requestBody");
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = null;
      }
    }
    const hashes = hashRequestBody(body);

    const properties =
      (get("properties", "request_properties") as Record<string, unknown> | undefined) ?? {};
    const sessionId =
      str(get("session_id", "helicone-session-id")) ??
      str(properties["Helicone-Session-Id"]) ??
      str(properties["helicone-session-id"]) ??
      null;

    const promptId = str(get("prompt_id", "helicone-prompt-id"));

    records.push({
      id: str(get("helicone-id", "heliconeId", "request_id", "id")) ?? `helicone_${index}`,
      timestamp: iso,
      ts,
      provider: str(get("provider"))?.toLowerCase() ?? inferProvider(model),
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: num(get("cache_read_input_tokens", "prompt_cache_read_tokens", "cache_read_tokens")) ?? 0,
      cache_write_tokens: num(get("cache_creation_input_tokens", "prompt_cache_write_tokens", "cache_write_tokens")) ?? 0,
      status: num(get("response_status", "status")) ?? 200,
      latency_ms: num(get("delay_ms", "latency", "latency_ms", "duration_ms")) ?? 0,
      session_id: sessionId,
      system_prompt_hash:
        hashes.system_prompt_hash ?? (promptId ? sha256(promptId) : null),
      full_prompt_hash: hashes.full_prompt_hash,
      max_tokens_set: hashes.max_tokens_set ?? true,
      metadata: properties,
    });
    index++;
  }

  return { records, skips };
}

function bump(skips: SkipStats, field: string): void {
  skips.missingFields.set(field, (skips.missingFields.get(field) ?? 0) + 1);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

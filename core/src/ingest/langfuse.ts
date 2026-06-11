import type { CanonicalRecord, SkipStats } from "../core/schema.js";
import { inferProvider, parseTimestamp } from "../core/schema.js";
import { parseCsv } from "./csv.js";
import { hashRequestBody, sha256 } from "./hash.js";

/**
 * Langfuse generations export adapter (JSON array, JSONL, or CSV).
 * traceId maps to session_id (traces → sessions, PRD §5.1).
 */
export function ingestLangfuse(text: string): { records: CanonicalRecord[]; skips: SkipStats } {
  const skips: SkipStats = { total: 0, skipped: 0, missingFields: new Map() };
  const records: CanonicalRecord[] = [];

  const firstChar = text.trimStart()[0];
  const rawRows: Record<string, unknown>[] = [];
  if (firstChar === "[") {
    try {
      rawRows.push(...(JSON.parse(text) as Record<string, unknown>[]));
    } catch {
      /* ignore */
    }
  } else if (firstChar === "{") {
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
  } else {
    rawRows.push(...parseCsv(text).rows);
  }

  let index = 0;
  for (const row of rawRows) {
    skips.total++;
    const usage = (row.usage ?? {}) as Record<string, unknown>;
    const get = (...keys: string[]): unknown => {
      for (const k of keys) {
        if (row[k] !== undefined && row[k] !== "") return row[k];
        if (usage[k] !== undefined && usage[k] !== "") return usage[k];
      }
      return undefined;
    };

    const model = strv(get("model", "modelId", "internalModel"));
    if (!model) {
      skips.skipped++;
      bump(skips, "model");
      continue;
    }
    const inputTokens = num(get("promptTokens", "input", "inputUsage", "usage.promptTokens", "prompt_tokens", "input_tokens"));
    if (inputTokens === null) {
      skips.skipped++;
      bump(skips, "input_tokens");
      continue;
    }
    const outputTokens =
      num(get("completionTokens", "output", "outputUsage", "usage.completionTokens", "completion_tokens", "output_tokens")) ?? 0;
    const tsRaw = get("startTime", "start_time", "timestamp", "createdAt");
    if (tsRaw === undefined) {
      skips.skipped++;
      bump(skips, "timestamp");
      continue;
    }
    const { iso, ts } = parseTimestamp(tsRaw);

    // Langfuse `input` field may carry the prompt body — hash in memory only.
    let systemHash: string | null = null;
    let fullHash: string | null = null;
    let maxTokensSet: boolean | null = null;
    const input = row.input;
    if (input !== undefined && input !== null && typeof input !== "number") {
      if (typeof input === "string") {
        fullHash = sha256(input);
      } else {
        const hashes = hashRequestBody(
          Array.isArray(input) ? { messages: input } : (input as Record<string, unknown>)
        );
        systemHash = hashes.system_prompt_hash;
        fullHash = hashes.full_prompt_hash;
        maxTokensSet = hashes.max_tokens_set;
      }
    }
    const modelParams = row.modelParameters as Record<string, unknown> | undefined;
    if (modelParams && ("max_tokens" in modelParams || "maxTokens" in modelParams)) {
      maxTokensSet = true;
    }
    if (!systemHash) {
      const promptName = strv(get("promptName", "prompt_name"));
      if (promptName) systemHash = sha256(promptName);
    }

    const latencyRaw = num(get("latency", "latency_ms", "duration"));

    records.push({
      id: strv(get("id", "observationId", "generationId")) ?? `langfuse_${index}`,
      timestamp: iso,
      ts,
      provider: inferProvider(model),
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: num(get("cacheReadInputTokens", "cache_read_tokens", "cachedTokens")) ?? 0,
      cache_write_tokens: num(get("cacheCreationInputTokens", "cache_write_tokens")) ?? 0,
      status: strv(get("level")) === "ERROR" ? 500 : (num(get("statusCode", "status")) ?? 200),
      // Langfuse latency is in seconds when < 1000-ish; exports vary. Accept ms if large.
      latency_ms: latencyRaw === null ? 0 : latencyRaw < 1000 ? Math.round(latencyRaw * 1000) : latencyRaw,
      session_id: strv(get("traceId", "trace_id", "sessionId", "session_id")),
      system_prompt_hash: systemHash,
      full_prompt_hash: fullHash,
      max_tokens_set: maxTokensSet ?? true,
      metadata: (row.metadata as Record<string, unknown> | undefined) ?? {},
    });
    index++;
  }

  return { records, skips };
}

function bump(skips: SkipStats, field: string): void {
  skips.missingFields.set(field, (skips.missingFields.get(field) ?? 0) + 1);
}

function strv(v: unknown): string | null {
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

/**
 * Canonical record schema (PRD §5.2). Every input format is normalized to this.
 *
 * PRIVACY (hard requirement): if a source export contains prompt/response
 * bodies, TokenTriage computes hashes and lengths IN MEMORY ONLY and never
 * writes bodies to disk, cache, or report.
 */

export interface CanonicalRecord {
  id: string;
  timestamp: string; // ISO-8601 as given by the source
  /** Parsed epoch ms (internal). NaN when the timestamp was unparsable. */
  ts: number;
  provider: string; // "anthropic" | "openai" | "other"
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  status: number;
  latency_ms: number;
  session_id: string | null;
  system_prompt_hash: string | null;
  full_prompt_hash: string | null;
  max_tokens_set: boolean;
  metadata: Record<string, unknown>;
  /** True for aggregate rows (e.g. OpenAI usage CSV) that represent many requests. */
  aggregate?: boolean;
  /** Number of underlying requests an aggregate row represents (1 for normal records). */
  n_requests?: number;
}

export interface Session {
  id: string;
  records: CanonicalRecord[]; // sorted by ts ascending
  inferred: boolean;
}

export interface SkipStats {
  total: number;
  skipped: number;
  /** field name -> times it was the reason a record was skipped */
  missingFields: Map<string, number>;
}

export function inferProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (
    m.startsWith("gpt") ||
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("o4") ||
    m.startsWith("chatgpt") ||
    m.startsWith("text-davinci")
  ) {
    return "openai";
  }
  return "other";
}

export function parseTimestamp(value: unknown): { iso: string; ts: number } {
  if (typeof value === "number") {
    // Heuristic: seconds vs milliseconds epoch
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return { iso: d.toISOString(), ts: d.getTime() };
  }
  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return { iso: d.toISOString(), ts: d.getTime() };
    return { iso: value, ts: NaN };
  }
  return { iso: "", ts: NaN };
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Map a raw object that already follows (or approximates) the canonical
 * schema into a CanonicalRecord. Returns the missing required field name on
 * failure so ingest can report W-201's "top missing fields".
 */
export function toCanonical(
  raw: Record<string, unknown>,
  index: number
): { record: CanonicalRecord } | { missingField: string } {
  const model = typeof raw.model === "string" && raw.model !== "" ? raw.model : null;
  if (!model) return { missingField: "model" };

  const input = asNumber(raw.input_tokens);
  if (input === null) return { missingField: "input_tokens" };
  const output = asNumber(raw.output_tokens);
  if (output === null) return { missingField: "output_tokens" };

  if (raw.timestamp === undefined || raw.timestamp === null) {
    return { missingField: "timestamp" };
  }
  const { iso, ts } = parseTimestamp(raw.timestamp);

  const provider =
    typeof raw.provider === "string" && raw.provider !== ""
      ? raw.provider.toLowerCase()
      : inferProvider(model);

  return {
    record: {
      id: typeof raw.id === "string" ? raw.id : `rec_${index}`,
      timestamp: iso,
      ts,
      provider,
      model,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: asNumber(raw.cache_read_tokens) ?? 0,
      cache_write_tokens: asNumber(raw.cache_write_tokens) ?? 0,
      status: asNumber(raw.status) ?? 200,
      latency_ms: asNumber(raw.latency_ms) ?? 0,
      session_id: typeof raw.session_id === "string" && raw.session_id !== "" ? raw.session_id : null,
      system_prompt_hash:
        typeof raw.system_prompt_hash === "string" && raw.system_prompt_hash !== ""
          ? raw.system_prompt_hash
          : null,
      full_prompt_hash:
        typeof raw.full_prompt_hash === "string" && raw.full_prompt_hash !== ""
          ? raw.full_prompt_hash
          : null,
      // Conservative default: unknown means "assume the caller set a cap" so
      // the verbose-output analyzer doesn't fire on missing data.
      max_tokens_set: typeof raw.max_tokens_set === "boolean" ? raw.max_tokens_set : true,
      metadata:
        raw.metadata && typeof raw.metadata === "object"
          ? (raw.metadata as Record<string, unknown>)
          : {},
    },
  };
}

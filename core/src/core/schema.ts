import { z } from "zod";

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

/** Accepts numbers or numeric strings (CSV-sourced exports coerce cleanly). */
const numeric = z
  .union([z.number(), z.string().trim().min(1)])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n), { message: "not a finite number" });

const nullableString = z
  .string()
  .nullish()
  .transform((s) => (s ? s : null));

/**
 * zod validator for the canonical input schema (PRD §5.2). Field order here
 * determines which "missing field" is reported first for W-201.
 */
export const canonicalInputSchema = z.object({
  model: z.string().min(1),
  input_tokens: numeric,
  output_tokens: numeric,
  timestamp: z.union([z.string().min(1), z.number()]),
  id: z.string().optional(),
  provider: z.string().optional(),
  cache_read_tokens: numeric.optional(),
  cache_write_tokens: numeric.optional(),
  status: numeric.optional(),
  latency_ms: numeric.optional(),
  session_id: nullableString,
  system_prompt_hash: nullableString,
  full_prompt_hash: nullableString,
  max_tokens_set: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Map a raw object that already follows (or approximates) the canonical
 * schema into a CanonicalRecord. Returns the missing/invalid required field
 * name on failure so ingest can report W-201's "top missing fields".
 */
export function toCanonical(
  raw: Record<string, unknown>,
  index: number
): { record: CanonicalRecord } | { missingField: string } {
  const parsed = canonicalInputSchema.safeParse(raw);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return { missingField: typeof field === "string" ? field : "(invalid record)" };
  }
  const v = parsed.data;
  const { iso, ts } = parseTimestamp(v.timestamp);

  return {
    record: {
      id: v.id ?? `rec_${index}`,
      timestamp: iso,
      ts,
      provider: v.provider ? v.provider.toLowerCase() : inferProvider(v.model),
      model: v.model,
      input_tokens: v.input_tokens,
      output_tokens: v.output_tokens,
      cache_read_tokens: v.cache_read_tokens ?? 0,
      cache_write_tokens: v.cache_write_tokens ?? 0,
      status: v.status ?? 200,
      latency_ms: v.latency_ms ?? 0,
      session_id: v.session_id,
      system_prompt_hash: v.system_prompt_hash,
      full_prompt_hash: v.full_prompt_hash,
      // Conservative default: unknown means "assume the caller set a cap" so
      // the verbose-output analyzer doesn't fire on missing data.
      max_tokens_set: v.max_tokens_set ?? true,
      metadata: v.metadata ?? {},
    },
  };
}

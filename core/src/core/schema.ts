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

/** Number or numeric string (same semantics as the zod `numeric` type, fast). */
function asNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Hot-path validation: equivalent to canonicalInputSchema for VALID records,
 * but ~10× cheaper per record (the 1M-records-in-60s NFR lives here).
 * Returns null when anything is off; the caller then re-runs zod to get a
 * precise missing-field diagnosis for W-201.
 */
function fastParse(raw: Record<string, unknown>): z.infer<typeof canonicalInputSchema> | null {
  if (typeof raw.model !== "string" || raw.model === "") return null;
  const input = asNum(raw.input_tokens);
  const output = asNum(raw.output_tokens);
  if (input === null || output === null) return null;
  const tsOk =
    (typeof raw.timestamp === "string" && raw.timestamp !== "") || typeof raw.timestamp === "number";
  if (!tsOk) return null;
  if (raw.id !== undefined && typeof raw.id !== "string") return null;
  if (raw.provider !== undefined && typeof raw.provider !== "string") return null;
  const optNum = (v: unknown): number | undefined | null =>
    v === undefined ? undefined : asNum(v);
  const cacheRead = optNum(raw.cache_read_tokens);
  const cacheWrite = optNum(raw.cache_write_tokens);
  const status = optNum(raw.status);
  const latency = optNum(raw.latency_ms);
  if (cacheRead === null || cacheWrite === null || status === null || latency === null) return null;
  const optStr = (v: unknown): string | null | undefined | false =>
    v === undefined || v === null ? null : typeof v === "string" ? (v === "" ? null : v) : false;
  const sessionId = optStr(raw.session_id);
  const sysHash = optStr(raw.system_prompt_hash);
  const fullHash = optStr(raw.full_prompt_hash);
  if (sessionId === false || sysHash === false || fullHash === false) return null;
  if (raw.max_tokens_set !== undefined && typeof raw.max_tokens_set !== "boolean") return null;
  if (raw.metadata !== undefined && (typeof raw.metadata !== "object" || raw.metadata === null || Array.isArray(raw.metadata)))
    return null;

  return {
    model: raw.model,
    input_tokens: input,
    output_tokens: output,
    timestamp: raw.timestamp as string | number,
    id: raw.id as string | undefined,
    provider: raw.provider as string | undefined,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    status,
    latency_ms: latency,
    session_id: sessionId ?? null,
    system_prompt_hash: sysHash ?? null,
    full_prompt_hash: fullHash ?? null,
    max_tokens_set: raw.max_tokens_set as boolean | undefined,
    metadata: raw.metadata as Record<string, unknown> | undefined,
  };
}

/**
 * Map a raw object that already follows (or approximates) the canonical
 * schema into a CanonicalRecord. Returns the missing/invalid required field
 * name on failure so ingest can report W-201's "top missing fields".
 */
export function toCanonical(
  raw: Record<string, unknown>,
  index: number
): { record: CanonicalRecord } | { missingField: string } {
  let v = fastParse(raw);
  if (!v) {
    // Slow path only for invalid records: zod produces the precise diagnosis.
    const parsed = canonicalInputSchema.safeParse(raw);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      return { missingField: typeof field === "string" ? field : "(invalid record)" };
    }
    v = parsed.data;
  }
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

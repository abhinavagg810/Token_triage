import fs from "node:fs";
import readline from "node:readline";
import type { CanonicalRecord, SkipStats } from "../core/schema.js";
import { toCanonical } from "../core/schema.js";

function emptySkips(): SkipStats {
  return { total: 0, skipped: 0, missingFields: new Map() };
}

function processLine(
  line: string,
  records: CanonicalRecord[],
  skips: SkipStats,
  index: { n: number }
): void {
  const trimmed = line.trim();
  if (trimmed === "") return;
  skips.total++;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    skips.skipped++;
    skips.missingFields.set("(unparsable JSON)", (skips.missingFields.get("(unparsable JSON)") ?? 0) + 1);
    return;
  }
  const result = toCanonical(raw, index.n++);
  if ("missingField" in result) {
    skips.skipped++;
    skips.missingFields.set(result.missingField, (skips.missingFields.get(result.missingField) ?? 0) + 1);
    return;
  }
  records.push(result.record);
}

/** Generic JSONL ingest from an in-memory string (tests, adapters, small files). */
export function ingestGenericJsonl(text: string): { records: CanonicalRecord[]; skips: SkipStats } {
  const records: CanonicalRecord[] = [];
  const skips = emptySkips();
  const index = { n: 0 };
  for (const line of text.split(/\r?\n/)) processLine(line, records, skips, index);
  return { records, skips };
}

/**
 * Streaming generic JSONL ingest — the documented canonical path. Reads the
 * file line by line so multi-GB logs never need to fit in memory (only the
 * compact normalized records do; this format carries no prompt bodies).
 */
export async function ingestGenericJsonlStream(
  filePath: string
): Promise<{ records: CanonicalRecord[]; skips: SkipStats }> {
  const records: CanonicalRecord[] = [];
  const skips = emptySkips();
  const index = { n: 0 };
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) processLine(line, records, skips, index);
  return { records, skips };
}

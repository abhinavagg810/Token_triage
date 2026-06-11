import type { CanonicalRecord, SkipStats } from "../core/schema.js";
import { toCanonical } from "../core/schema.js";

/** Generic JSONL ingest — the documented canonical path. */
export function ingestGenericJsonl(text: string): { records: CanonicalRecord[]; skips: SkipStats } {
  const records: CanonicalRecord[] = [];
  const skips: SkipStats = { total: 0, skipped: 0, missingFields: new Map() };

  let index = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    skips.total++;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      skips.skipped++;
      skips.missingFields.set("(unparsable JSON)", (skips.missingFields.get("(unparsable JSON)") ?? 0) + 1);
      continue;
    }
    const result = toCanonical(raw, index++);
    if ("missingField" in result) {
      skips.skipped++;
      skips.missingFields.set(result.missingField, (skips.missingFields.get(result.missingField) ?? 0) + 1);
      continue;
    }
    records.push(result.record);
  }
  return { records, skips };
}

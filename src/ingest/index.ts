import fs from "node:fs";
import path from "node:path";
import type { CanonicalRecord, SkipStats } from "../core/schema.js";
import { detectFormat, type LogFormat } from "./detect.js";
import { ingestGenericJsonl } from "./jsonl.js";
import { ingestHelicone } from "./helicone.js";
import { ingestLangfuse } from "./langfuse.js";
import { ingestOpenAiUsage } from "./openai-usage.js";

export class IngestError extends Error {
  constructor(
    public code: "E-101" | "E-102",
    message: string
  ) {
    super(message);
  }
}

export interface IngestResult {
  records: CanonicalRecord[];
  skips: SkipStats;
  formats: LogFormat[];
  files: string[];
}

const INGESTERS: Record<LogFormat, (text: string) => { records: CanonicalRecord[]; skips: SkipStats }> = {
  "generic-jsonl": ingestGenericJsonl,
  helicone: ingestHelicone,
  langfuse: ingestLangfuse,
  "openai-usage": ingestOpenAiUsage,
};

const DATA_EXTENSIONS = new Set([".jsonl", ".json", ".csv", ".ndjson", ".log"]);

/** Ingest a file or directory (all matching files concatenated), auto-detecting format. */
export function ingestPath(inputPath: string): IngestResult {
  if (!fs.existsSync(inputPath)) {
    throw new IngestError("E-102", `No valid records found in ${inputPath}. Check the file isn't empty and matches a supported format.`);
  }

  const files: string[] = [];
  if (fs.statSync(inputPath).isDirectory()) {
    for (const entry of fs.readdirSync(inputPath).sort()) {
      const full = path.join(inputPath, entry);
      if (fs.statSync(full).isFile() && DATA_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
        files.push(full);
      }
    }
  } else {
    files.push(inputPath);
  }

  const allRecords: CanonicalRecord[] = [];
  const skips: SkipStats = { total: 0, skipped: 0, missingFields: new Map() };
  const formats: LogFormat[] = [];

  for (const file of files) {
    const text = fs.readFileSync(file, "utf-8");
    if (text.trim() === "") continue;
    const format = detectFormat(text);
    if (!format) {
      throw new IngestError(
        "E-101",
        "Could not detect log format. Supported: generic JSONL, Helicone export, Langfuse export, OpenAI usage CSV. See: tokentriage formats"
      );
    }
    formats.push(format);
    const { records, skips: fileSkips } = INGESTERS[format](text);
    allRecords.push(...records);
    skips.total += fileSkips.total;
    skips.skipped += fileSkips.skipped;
    for (const [field, count] of fileSkips.missingFields) {
      skips.missingFields.set(field, (skips.missingFields.get(field) ?? 0) + count);
    }
  }

  if (allRecords.length === 0) {
    throw new IngestError(
      "E-102",
      `No valid records found in ${inputPath}. Check the file isn't empty and matches a supported format.`
    );
  }

  allRecords.sort((a, b) => (Number.isNaN(a.ts) ? 1 : Number.isNaN(b.ts) ? -1 : a.ts - b.ts));
  return { records: allRecords, skips, formats, files };
}

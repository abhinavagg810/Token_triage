import fs from "node:fs";
import path from "node:path";
import type { CanonicalRecord, SkipStats } from "../core/schema.js";
import { detectFormat, type LogFormat } from "./detect.js";
import { ingestGenericJsonlStream } from "./jsonl.js";
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

/** Buffered adapters (export files from these tools are comparatively small). */
const BUFFERED_INGESTERS: Record<string, (text: string) => { records: CanonicalRecord[]; skips: SkipStats }> = {
  helicone: ingestHelicone,
  langfuse: ingestLangfuse,
  "openai-usage": ingestOpenAiUsage,
};

const DATA_EXTENSIONS = new Set([".jsonl", ".json", ".csv", ".ndjson", ".log"]);
const SNIFF_BYTES = 256 * 1024;

/** Read just enough of a file to detect its format without loading it all. */
function sniff(filePath: string): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(Math.min(SNIFF_BYTES, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    let text = buf.toString("utf-8");
    // Drop a possibly truncated last line so detection sees only complete lines.
    const lastNewline = text.lastIndexOf("\n");
    if (buf.length === SNIFF_BYTES && lastNewline > 0) text = text.slice(0, lastNewline);
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Ingest a file or directory (all matching files concatenated), auto-detecting
 * the format from a small sniff. Generic JSONL is stream-parsed line by line
 * so large logs never need to fit in memory.
 */
export async function ingestPath(inputPath: string): Promise<IngestResult> {
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
    const head = sniff(file);
    if (head.trim() === "") continue;
    const format = detectFormat(head);
    if (!format) {
      throw new IngestError(
        "E-101",
        "Could not detect log format. Supported: generic JSONL, Helicone export, Langfuse export, OpenAI usage CSV. See: tokentriage formats"
      );
    }
    formats.push(format);
    const { records, skips: fileSkips } =
      format === "generic-jsonl"
        ? await ingestGenericJsonlStream(file)
        : BUFFERED_INGESTERS[format]!(fs.readFileSync(file, "utf-8"));
    // No spread here: push(...arr) overflows the call stack on huge files.
    for (const r of records) allRecords.push(r);
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

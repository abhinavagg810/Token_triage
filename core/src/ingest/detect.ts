import { parseCsvLine } from "./csv.js";

export type LogFormat = "generic-jsonl" | "helicone" | "langfuse" | "openai-usage";

/**
 * Format auto-detection (PRD §5.1): sniff the first 50 lines.
 * Returns null when ambiguous (caller raises E-101).
 */
export function detectFormat(text: string): LogFormat | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 50);
  if (lines.length === 0) return null;

  const first = lines[0]!.trim();

  // JSON / JSONL paths
  if (first.startsWith("{") || first.startsWith("[")) {
    let obj: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(first.startsWith("[") ? text : first);
      obj = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown>) : parsed;
    } catch {
      // JSONL where the array spans lines — try line one only
      try {
        obj = JSON.parse(first) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    if (!obj || typeof obj !== "object") return null;
    const keys = Object.keys(obj);
    const keySet = new Set(keys.map((k) => k.toLowerCase()));

    if (keys.some((k) => k.toLowerCase().includes("helicone"))) return "helicone";
    if (
      keySet.has("traceid") ||
      keySet.has("observationid") ||
      (typeof obj.usage === "object" &&
        obj.usage !== null &&
        ("promptTokens" in (obj.usage as object) || "input" in (obj.usage as object)))
    ) {
      return "langfuse";
    }
    if (keySet.has("input_tokens") && keySet.has("output_tokens") && keySet.has("model")) {
      return "generic-jsonl";
    }
    // Helicone JSONL without explicit helicone-prefixed keys
    if (keySet.has("prompt_tokens") && keySet.has("completion_tokens")) return "helicone";
    return null;
  }

  // CSV paths — inspect the header row
  const headers = parseCsvLine(first).map((h) => h.trim().toLowerCase());
  const headerSet = new Set(headers);
  if (
    headerSet.has("n_context_tokens_total") ||
    headerSet.has("n_generated_tokens_total") ||
    (headerSet.has("n_requests") && headerSet.has("model"))
  ) {
    return "openai-usage";
  }
  if (headers.some((h) => h.includes("helicone"))) return "helicone";
  if (headerSet.has("traceid") || headers.some((h) => h.includes("prompttokens"))) {
    return "langfuse";
  }
  return null;
}

import { describe, it, expect } from "vitest";
import { detectFormat } from "../src/ingest/detect.js";
import { ingestGenericJsonl } from "../src/ingest/jsonl.js";
import { ingestHelicone } from "../src/ingest/helicone.js";
import { ingestLangfuse } from "../src/ingest/langfuse.js";
import { ingestOpenAiUsage } from "../src/ingest/openai-usage.js";

const GENERIC_LINE = JSON.stringify({
  id: "req_001",
  timestamp: "2026-05-04T09:12:01Z",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  input_tokens: 3120,
  output_tokens: 410,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  status: 200,
  latency_ms: 2140,
  session_id: "sess_91",
  system_prompt_hash: "a3f9c2",
  full_prompt_hash: "7be1d0",
  max_tokens_set: true,
  metadata: { agent: "hr-agent" },
});

const HELICONE_JSONL = JSON.stringify({
  "helicone-id": "h-123",
  request_created_at: "2026-05-04T09:12:01Z",
  model: "gpt-4o-2024-11-20",
  prompt_tokens: 1200,
  completion_tokens: 300,
  response_status: 200,
  delay_ms: 900,
  request_body: { messages: [{ role: "system", content: "You are helpful." }], max_tokens: 500 },
  properties: { "Helicone-Session-Id": "sess-1" },
});

const LANGFUSE_JSONL = JSON.stringify({
  id: "gen-1",
  traceId: "trace-9",
  startTime: "2026-05-04T09:12:01Z",
  model: "claude-sonnet-4-5",
  usage: { promptTokens: 2200, completionTokens: 150 },
  input: [{ role: "system", content: "You are an agent." }],
  metadata: { env: "prod" },
});

const OPENAI_CSV = `date,model,n_requests,n_context_tokens_total,n_generated_tokens_total
2026-05-01,gpt-4o-2024-11-20,420,1250000,98000
2026-05-02,gpt-4o-mini,1300,2400000,310000`;

describe("format detection", () => {
  it("detects generic JSONL", () => expect(detectFormat(GENERIC_LINE)).toBe("generic-jsonl"));
  it("detects Helicone JSONL", () => expect(detectFormat(HELICONE_JSONL)).toBe("helicone"));
  it("detects Langfuse JSONL", () => expect(detectFormat(LANGFUSE_JSONL)).toBe("langfuse"));
  it("detects OpenAI usage CSV", () => expect(detectFormat(OPENAI_CSV)).toBe("openai-usage"));
  it("returns null on garbage (E-101 path)", () => expect(detectFormat("hello\nworld")).toBeNull());
});

describe("generic JSONL adapter", () => {
  it("maps canonical records and counts skips by missing field", () => {
    const text = [GENERIC_LINE, '{"model":"gpt-4o"}', "not json"].join("\n");
    const { records, skips } = ingestGenericJsonl(text);
    expect(records).toHaveLength(1);
    expect(records[0]!.session_id).toBe("sess_91");
    expect(skips.skipped).toBe(2);
    expect(skips.missingFields.get("input_tokens")).toBe(1);
  });
});

describe("Helicone adapter", () => {
  it("maps rows and hashes bodies in memory (never stores them)", () => {
    const { records } = ingestHelicone(HELICONE_JSONL);
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.id).toBe("h-123");
    expect(r.provider).toBe("openai");
    expect(r.input_tokens).toBe(1200);
    expect(r.session_id).toBe("sess-1");
    expect(r.max_tokens_set).toBe(true);
    expect(r.system_prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    // the raw body must not survive anywhere on the record
    expect(JSON.stringify(r)).not.toContain("You are helpful");
  });
});

describe("Langfuse adapter", () => {
  it("maps generations and uses traceId as session", () => {
    const { records } = ingestLangfuse(LANGFUSE_JSONL);
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.session_id).toBe("trace-9");
    expect(r.input_tokens).toBe(2200);
    expect(r.provider).toBe("anthropic");
    expect(r.system_prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r)).not.toContain("You are an agent");
  });
});

describe("OpenAI usage CSV adapter", () => {
  it("produces aggregate-only records", () => {
    const { records } = ingestOpenAiUsage(OPENAI_CSV);
    expect(records).toHaveLength(2);
    expect(records[0]!.aggregate).toBe(true);
    expect(records[0]!.n_requests).toBe(420);
    expect(records[0]!.input_tokens).toBe(1_250_000);
  });
});

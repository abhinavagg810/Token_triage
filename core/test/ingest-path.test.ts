import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestPath, IngestError } from "../src/ingest/index.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tt-ingest-"));
}

const GENERIC = (id: string) =>
  JSON.stringify({
    id,
    timestamp: "2026-05-04T09:12:01Z",
    model: "claude-sonnet-4-5",
    input_tokens: 100,
    output_tokens: 10,
  });

describe("ingestPath", () => {
  it("streams a generic JSONL file", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "logs.jsonl");
    fs.writeFileSync(file, [GENERIC("a"), GENERIC("b"), GENERIC("c")].join("\n"));
    const result = await ingestPath(file);
    expect(result.records).toHaveLength(3);
    expect(result.formats).toEqual(["generic-jsonl"]);
  });

  it("concatenates all matching files in a directory, mixed formats", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "a.jsonl"), GENERIC("a1"));
    fs.writeFileSync(
      path.join(dir, "b.csv"),
      "date,model,n_requests,n_context_tokens_total,n_generated_tokens_total\n2026-05-01,gpt-4o,10,5000,400"
    );
    fs.writeFileSync(path.join(dir, "ignored.txt"), "not a log");
    const result = await ingestPath(dir);
    expect(result.records).toHaveLength(2);
    expect(result.formats.sort()).toEqual(["generic-jsonl", "openai-usage"]);
  });

  it("raises E-101 with the exact PRD copy on undetectable formats", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "garbage.log");
    fs.writeFileSync(file, "hello\nworld\n");
    await expect(ingestPath(file)).rejects.toMatchObject({
      code: "E-101",
      message:
        "Could not detect log format. Supported: generic JSONL, Helicone export, Langfuse export, OpenAI usage CSV. See: tokentriage formats",
    });
  });

  it("raises E-102 with the exact PRD copy on empty/missing input", async () => {
    const dir = tmpDir();
    const missing = path.join(dir, "nope.jsonl");
    await expect(ingestPath(missing)).rejects.toMatchObject({ code: "E-102" });
    await expect(ingestPath(missing)).rejects.toThrowError(
      `No valid records found in ${missing}. Check the file isn't empty and matches a supported format.`
    );

    const empty = path.join(dir, "empty.jsonl");
    fs.writeFileSync(empty, "\n\n");
    await expect(ingestPath(empty)).rejects.toMatchObject({ code: "E-102" });
  });

  it("E-102 also fires when every record is invalid", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "bad.jsonl");
    // detected as generic (has the signature keys) but every line missing required values
    fs.writeFileSync(
      file,
      '{"model":"claude-sonnet-4-5","input_tokens":null,"output_tokens":1,"timestamp":"2026-05-01T00:00:00Z"}\n'
    );
    await expect(ingestPath(file)).rejects.toMatchObject({ code: "E-102" });
    expect(IngestError).toBeDefined();
  });
});

describe("CSV adapter fixtures", () => {
  it("Helicone CSV export maps to canonical records", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "helicone.csv");
    fs.writeFileSync(
      file,
      [
        "helicone-id,request_created_at,model,prompt_tokens,completion_tokens,response_status,delay_ms",
        'h-1,2026-05-04T09:12:01Z,gpt-4o,1200,300,200,900',
        'h-2,2026-05-04T09:13:01Z,gpt-4o,1300,200,200,800',
      ].join("\n")
    );
    const result = await ingestPath(file);
    expect(result.formats).toEqual(["helicone"]);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]!.provider).toBe("openai");
    expect(result.records[0]!.input_tokens).toBe(1200);
  });

  it("Langfuse CSV export maps traceId to session", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "langfuse.csv");
    fs.writeFileSync(
      file,
      [
        "id,traceId,startTime,model,promptTokens,completionTokens",
        "g-1,trace-7,2026-05-04T09:12:01Z,claude-sonnet-4-5,2200,150",
      ].join("\n")
    );
    const result = await ingestPath(file);
    expect(result.formats).toEqual(["langfuse"]);
    expect(result.records[0]!.session_id).toBe("trace-7");
    expect(result.records[0]!.provider).toBe("anthropic");
  });
});

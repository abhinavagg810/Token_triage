import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateNarrative } from "../src/report/narrative.js";
import { analyze } from "../src/core/engine.js";
import { rec, testPricing } from "./helpers.js";
import type { SkipStats } from "../src/core/schema.js";

const noSkips = (): SkipStats => ({ total: 10, skipped: 0, missingFields: new Map() });

function result() {
  const base = Date.UTC(2026, 4, 12, 9);
  const records = Array.from({ length: 30 }, (_, i) =>
    rec({
      id: `n${i}`,
      ts: base + i * 3_600_000,
      system_prompt_hash: "deadbeefcafe",
      full_prompt_hash: `full_${i}`,
      session_id: "sess_secret",
      input_tokens: 4_000,
    })
  );
  return analyze(records, testPricing(), noSkips());
}

describe("--narrate (the only network call)", () => {
  const origKey = process.env.TOKENTRIAGE_LLM_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    if (origKey === undefined) delete process.env.TOKENTRIAGE_LLM_KEY;
    else process.env.TOKENTRIAGE_LLM_KEY = origKey;
    vi.unstubAllGlobals();
  });

  it("refuses to run without TOKENTRIAGE_LLM_KEY", async () => {
    delete process.env.TOKENTRIAGE_LLM_KEY;
    await expect(generateNarrative(result())).rejects.toThrow("TOKENTRIAGE_LLM_KEY");
  });

  it("sends AGGREGATED FINDINGS ONLY — never hashes, ids or sessions", async () => {
    process.env.TOKENTRIAGE_LLM_KEY = "sk-ant-test123";
    let capturedUrl = "";
    let capturedBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        capturedUrl = String(url);
        capturedBody = init.body;
        return {
          ok: true,
          json: async () => ({ content: [{ type: "text", text: "Summary text." }] }),
        };
      })
    );

    const text = await generateNarrative(result());
    expect(text).toBe("Summary text.");
    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    // privacy: aggregated numbers only — no record-level identifiers leak
    expect(capturedBody).not.toContain("deadbeefcafe");
    expect(capturedBody).not.toContain("sess_secret");
    expect(capturedBody).not.toContain("full_");
    expect(capturedBody).toContain("total_spend_usd");
    expect(capturedBody).toContain("Prompt caching not used");
  });

  it("routes non-Anthropic keys to the OpenAI endpoint", async () => {
    process.env.TOKENTRIAGE_LLM_KEY = "sk-openai-test";
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        capturedUrl = String(url);
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: "OpenAI summary." } }] }),
        };
      })
    );
    const text = await generateNarrative(result());
    expect(text).toBe("OpenAI summary.");
    expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("surfaces API errors with status", async () => {
    process.env.TOKENTRIAGE_LLM_KEY = "sk-ant-test123";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, text: async () => "rate limited" }))
    );
    await expect(generateNarrative(result())).rejects.toThrow("429");
  });
});

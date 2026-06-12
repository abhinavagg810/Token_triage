import { describe, it, expect } from "vitest";
import { analyze } from "../src/core/engine.js";
import { renderJson } from "../src/report/json.js";
import { renderTerminal } from "../src/report/terminal.js";
import { renderHtml } from "../src/report/html.js";
import { ingestOpenAiUsage } from "../src/ingest/openai-usage.js";
import { rec, testPricing } from "./helpers.js";
import type { SkipStats } from "../src/core/schema.js";

const noSkips = (): SkipStats => ({ total: 100, skipped: 0, missingFields: new Map() });

function sampleResult() {
  const base = Date.UTC(2026, 4, 12, 9);
  const records = Array.from({ length: 60 }, (_, i) =>
    rec({
      id: `o${i}`,
      ts: base + i * 3_600_000,
      system_prompt_hash: "shared",
      input_tokens: 4_000,
      output_tokens: 200,
    })
  );
  return analyze(records, testPricing(), noSkips());
}

describe("--json output", () => {
  it("emits machine-readable findings with evidence and fix blocks", () => {
    const out = JSON.parse(renderJson(sampleResult()));
    expect(out.tool).toBe("tokentriage");
    expect(out.total_spend_usd).toBeGreaterThan(0);
    expect(out.addressable_waste_pct).toBeGreaterThan(0);
    const finding = out.findings[0];
    expect(finding.id).toBe("cache-miss");
    expect(finding.confidence).toBe("high");
    expect(Array.isArray(finding.evidence)).toBe(true);
    expect(finding.fix.summary.length).toBeGreaterThan(0);
    expect(finding.fix.steps.length).toBeGreaterThan(0);
    // CI usage: a pipeline can fail on this number
    expect(typeof out.addressable_waste_pct).toBe("number");
  });
});

describe("terminal output copy (PRD §5.7)", () => {
  it("prints W-202 verbatim for aggregate-only input", () => {
    const csv = `date,model,n_requests,n_context_tokens_total,n_generated_tokens_total
2026-05-01,gpt-4o,420,1250000,98000`;
    const { records, skips } = ingestOpenAiUsage(csv);
    const result = analyze(records, testPricing(), skips);
    const text = renderTerminal(result, null, false);
    expect(text).toContain(
      "W-202: OpenAI usage export is aggregate-only. Per-request analyzers (caching, context bloat, retries) were skipped. For full diagnosis, export from Helicone/Langfuse or use the generic JSONL schema."
    );
  });

  it("prints the small-sample banner with the PRD wording", () => {
    const result = analyze([rec({}), rec({})], testPricing(), noSkips());
    const text = renderTerminal(result, null, false);
    expect(text).toMatch(/Small sample \(N=2\)\. Findings are directional, not conclusive\./);
  });

  it("prints W-203 with the override path", () => {
    const result = analyze(
      [rec({ model: "mystery-9000", provider: "other" })],
      testPricing(),
      noSkips()
    );
    const text = renderTerminal(result, null, false);
    expect(text).toContain("costed at $0: mystery-9000");
    expect(text).toContain("~/.tokentriage/pricing.override.json");
  });
});

describe("HTML report", () => {
  it("is self-contained: no external script/style/font references", () => {
    const html = renderHtml(sampleResult());
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toContain("https://cdn");
    expect(html).not.toContain("fonts.googleapis");
  });

  it("renders the header strip, finding cards and footnotes", () => {
    const result = sampleResult();
    const html = renderHtml(result);
    expect(html).toContain("Total spend");
    expect(html).toContain("Potential monthly savings");
    expect(html).toContain("Prompt caching not used");
    expect(html).toContain("cache_control"); // copyable fix snippet
    expect(html).toContain("Unverified pricing"); // placeholder prices surfaced
    expect(html).toContain("no data left this machine");
  });

  it("never contains prompt content fields, only hashes", () => {
    const html = renderHtml(sampleResult());
    expect(html).not.toContain("request_body");
    // evidence shows truncated hashes
    expect(html).toContain("shared".slice(0, 6));
  });

  it("embeds the narrative when provided", () => {
    const html = renderHtml(sampleResult(), "First paragraph.\n\nSecond paragraph.");
    expect(html).toContain("Executive summary");
    expect(html).toContain("First paragraph.");
    expect(html).toContain("<p>Second paragraph.</p>");
  });
});

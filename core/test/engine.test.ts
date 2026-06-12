import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../src/core/engine.js";
import { ingestGenericJsonl } from "../src/ingest/jsonl.js";
import { ingestOpenAiUsage } from "../src/ingest/openai-usage.js";
import { rec, testPricing } from "./helpers.js";
import type { SkipStats } from "../src/core/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const noSkips = (): SkipStats => ({ total: 100, skipped: 0, missingFields: new Map() });

describe("engine", () => {
  it("ledger priority: retried calls are not also counted as cache misses", () => {
    const base = Date.UTC(2026, 4, 12, 9);
    // 12 calls sharing a system hash; calls 10 and 11 are duplicate fires of call 9.
    const records = Array.from({ length: 12 }, (_, i) =>
      rec({
        system_prompt_hash: "shared",
        full_prompt_hash: i >= 9 ? "dup" : `f${i}`,
        input_tokens: 4000,
        output_tokens: 200,
        ts: base + (i >= 10 ? 9 * 60_000 + (i - 9) * 5_000 : i * 60_000),
      })
    );
    const result = analyze(records, testPricing(), noSkips());
    const retry = result.findings.find((f) => f.analyzer_id === "retry-waste")!;
    const cache = result.findings.find((f) => f.analyzer_id === "cache-miss")!;
    expect(retry.wasted_usd).toBeCloseTo((2 * (4000 * 3 + 200 * 15)) / 1e6, 6);
    // cache-miss only gets the 9 non-duplicate repeats (11 repeats − 2 claimed)
    const expectedCache = (9 * 4000 * 2.7 - 4000 * 3.75) / 1e6;
    expect(cache.wasted_usd).toBeCloseTo(expectedCache, 5);
    // Combined waste never exceeds total spend
    expect(result.addressableWaste).toBeLessThanOrEqual(result.totalSpend);
  });

  it("emits W-201 when >10% of records were skipped", () => {
    const skips: SkipStats = {
      total: 9800,
      skipped: 1204,
      missingFields: new Map([
        ["input_tokens", 800],
        ["model", 404],
      ]),
    };
    const result = analyze([rec({})], testPricing(), skips);
    const w = result.warnings.find((x) => x.code === "W-201");
    expect(w).toBeDefined();
    expect(w!.message).toContain("Skipped 1,204 of 9,800 records (12%)");
    expect(w!.message).toContain("input_tokens, model");
  });

  it("aggregate-only input skips per-request analyzers and emits W-202", () => {
    const csv = `date,model,n_requests,n_context_tokens_total,n_generated_tokens_total
2026-05-01,gpt-4o,420,1250000,98000`;
    const { records, skips } = ingestOpenAiUsage(csv);
    const result = analyze(records, testPricing(), skips);
    expect(result.aggregateOnly).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.warnings.some((w) => w.code === "W-202")).toBe(true);
    expect(result.totalSpend).toBeGreaterThan(0); // spend analysis still works
  });

  it("emits W-203 for unpriced models, costed at $0", () => {
    const result = analyze(
      [rec({ model: "mystery-model-9000", provider: "other" })],
      testPricing(),
      noSkips()
    );
    const w = result.warnings.find((x) => x.code === "W-203");
    expect(w).toBeDefined();
    expect(w!.message).toContain("mystery-model-9000");
    expect(result.totalSpend).toBe(0);
  });

  it("flags small samples (<50 records)", () => {
    const result = analyze([rec({}), rec({})], testPricing(), noSkips());
    expect(result.smallSample).toBe(true);
  });

  it("--period restricts to the most recent N days", () => {
    const base = Date.UTC(2026, 4, 1);
    const records = [
      rec({ ts: base, input_tokens: 1000 }),
      rec({ ts: base + 40 * 86_400_000, input_tokens: 1000 }),
    ];
    const result = analyze(records, testPricing(), noSkips(), { periodDays: 7 });
    expect(result.records).toHaveLength(1);
  });

  it("sample dataset reproduces the PRD §12.5 story (every analyzer fires)", () => {
    const samplePath = path.resolve(__dirname, "..", "samples", "sample-logs.jsonl");
    const { records, skips } = ingestGenericJsonl(fs.readFileSync(samplePath, "utf-8"));
    const result = analyze(records, testPricing(), skips);

    const byId = Object.fromEntries(result.findings.map((f) => [f.analyzer_id, f]));
    expect(Object.keys(byId).sort()).toEqual([
      "cache-miss",
      "context-bloat",
      "dead-weight",
      "model-overkill",
      "retry-waste",
      "verbose-output",
    ]);
    // Ballpark acceptance (PRD §12.5): percentages of total spend
    expect(byId["cache-miss"]!.pct_of_total).toBeGreaterThan(0.24);
    expect(byId["cache-miss"]!.pct_of_total).toBeLessThan(0.32);
    expect(byId["context-bloat"]!.pct_of_total).toBeGreaterThan(0.08);
    expect(byId["context-bloat"]!.pct_of_total).toBeLessThan(0.12);
    expect(byId["model-overkill"]!.upper_bound).toBe(true);
    expect(byId["retry-waste"]!.evidence.some((e) => e.detail.includes("2026-05-12"))).toBe(true);
    // A6 (stretch): the webhook-router's uncached document-processing block
    expect(byId["dead-weight"]!.confidence).toBe("low");
    expect(byId["dead-weight"]!.wasted_usd).toBeGreaterThan(15);
    expect(byId["dead-weight"]!.wasted_usd).toBeLessThan(45);
    expect(result.totalSpend).toBeGreaterThan(800);
    expect(result.totalSpend).toBeLessThan(1100);
    expect(result.addressableWaste).toBeLessThanOrEqual(result.totalSpend);
  });

  it("invariant: addressable waste never exceeds total spend (randomized)", () => {
    // Seeded pseudo-random datasets hammering the claimed-token ledger:
    // duplicate hashes, shared system prompts, sessions, uncapped outputs.
    let seed = 0xc0ffee;
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

    for (let iter = 0; iter < 30; iter++) {
      const base = Date.UTC(2026, 4, 1) + iter * 1000;
      const n = 30 + Math.floor(rand() * 120);
      const records = Array.from({ length: n }, (_, i) =>
        rec({
          id: `r${iter}_${i}`,
          ts: base + Math.floor(rand() * 20) * 30_000,
          model: pick(["claude-sonnet-4-5", "claude-opus-4-1", "gpt-4o", "claude-haiku-4-5"]),
          provider: rand() < 0.7 ? "anthropic" : "openai",
          input_tokens: Math.floor(rand() * 40_000),
          output_tokens: Math.floor(rand() * 3_000),
          cache_read_tokens: rand() < 0.2 ? Math.floor(rand() * 5_000) : 0,
          status: rand() < 0.1 ? 500 : 200,
          session_id: rand() < 0.3 ? `s${Math.floor(rand() * 4)}` : null,
          system_prompt_hash: rand() < 0.6 ? `h${Math.floor(rand() * 3)}` : null,
          full_prompt_hash: rand() < 0.5 ? `f${Math.floor(rand() * 10)}` : `u${iter}_${i}`,
          max_tokens_set: rand() < 0.7,
          metadata: rand() < 0.5 ? { service: `svc${Math.floor(rand() * 3)}` } : {},
        })
      );
      const result = analyze(records, testPricing(), noSkips());
      expect(result.addressableWaste).toBeLessThanOrEqual(result.totalSpend + 1e-9);
      for (const f of result.findings) {
        expect(f.wasted_usd).toBeGreaterThanOrEqual(0);
        expect(f.pct_of_total).toBeLessThanOrEqual(1);
      }
    }
  });
});

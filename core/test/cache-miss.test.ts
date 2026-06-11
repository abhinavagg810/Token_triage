import { describe, it, expect } from "vitest";
import { cacheMiss } from "../src/analyzers/cache-miss.js";
import { rec, ctx } from "./helpers.js";

describe("A1 cache-miss", () => {
  it("fires on >=10 uncached calls sharing a system prompt hash", () => {
    const records = Array.from({ length: 20 }, (_, i) =>
      rec({
        system_prompt_hash: "abc",
        input_tokens: 3000 + i * 10, // stable minimum = 3000
        full_prompt_hash: `f${i}`,
      })
    );
    const finding = cacheMiss.detect(ctx(records));
    expect(finding).not.toBeNull();
    // (20-1) × 3000 × ($3.00 - $0.30)/MTok − 1 rewrite × 3000 × $3.75/MTok
    const expected = (19 * 3000 * 2.7 - 3000 * 3.75) / 1e6;
    expect(finding!.wasted_usd).toBeCloseTo(expected, 4);
    expect(finding!.confidence).toBe("high");
    expect(finding!.fix.snippet).toContain("cache_control");
  });

  it("does not fire below 10 occurrences", () => {
    const records = Array.from({ length: 9 }, () =>
      rec({ system_prompt_hash: "abc", input_tokens: 3000 })
    );
    expect(cacheMiss.detect(ctx(records))).toBeNull();
  });

  it("does not fire when caching is already in use", () => {
    const records = Array.from({ length: 20 }, (_, i) =>
      rec({ system_prompt_hash: "abc", input_tokens: 3000, cache_read_tokens: i === 0 ? 0 : 2800 })
    );
    expect(cacheMiss.detect(ctx(records))).toBeNull();
  });

  it("does not fire without system prompt hashes", () => {
    const records = Array.from({ length: 20 }, () => rec({ input_tokens: 3000 }));
    expect(cacheMiss.detect(ctx(records))).toBeNull();
  });

  it("matches the PRD §12.2 worked example within rounding", () => {
    // 14,202 calls, 2,940-token prefix, sonnet pricing → ~$111 waste
    const records = Array.from({ length: 14_202 }, (_, i) =>
      rec({ system_prompt_hash: "a3f9c2", input_tokens: 2940 + (i % 7), full_prompt_hash: `f${i}` })
    );
    const finding = cacheMiss.detect(ctx(records));
    expect(finding).not.toBeNull();
    expect(finding!.wasted_usd).toBeGreaterThan(105);
    expect(finding!.wasted_usd).toBeLessThan(115);
  });
});

import { describe, it, expect } from "vitest";
import { deadWeight } from "../src/analyzers/dead-weight.js";
import { cacheMiss } from "../src/analyzers/cache-miss.js";
import { TokenLedger } from "../src/core/ledger.js";
import { rec, ctx } from "./helpers.js";

function unhashedGroup(n: number, floor: number, jitter: number, service = "doc-router") {
  return Array.from({ length: n }, (_, i) =>
    rec({
      system_prompt_hash: null,
      input_tokens: floor + Math.floor((i / n) * jitter),
      metadata: { service },
    })
  );
}

describe("A6 dead-weight prompt", () => {
  it("fires on a large flat input floor with no hashes and no caching", () => {
    const records = unhashedGroup(40, 20_000, 2_000);
    const finding = deadWeight.detect(ctx(records));
    expect(finding).not.toBeNull();
    expect(finding!.confidence).toBe("low");
    // (40-1) × 20,000 × ($3.00-$0.30)/MTok − 1 rewrite × 20,000 × $3.75/MTok
    const expected = (39 * 20_000 * 2.7 - 20_000 * 3.75) / 1e6;
    expect(finding!.wasted_usd).toBeCloseTo(expected, 4);
    expect(finding!.fix.snippet).toContain("cache_control");
  });

  it("does not fire on hashed groups (cache-miss territory)", () => {
    const records = unhashedGroup(40, 20_000, 2_000).map((r) => ({
      ...r,
      system_prompt_hash: "abc",
    }));
    expect(deadWeight.detect(ctx(records))).toBeNull();
  });

  it("does not fire below 20 occurrences or below the 5K-token floor", () => {
    expect(deadWeight.detect(ctx(unhashedGroup(19, 20_000, 2_000)))).toBeNull();
    expect(deadWeight.detect(ctx(unhashedGroup(40, 1_600, 300)))).toBeNull();
  });

  it("does not fire when the floor is an outlier (unstable, no static block)", () => {
    // one 5K call, the rest spread 12K-20K: p25 >> 1.3 × floor
    const records = [
      rec({ system_prompt_hash: null, input_tokens: 5_000, metadata: { service: "x" } }),
      ...Array.from({ length: 39 }, (_, i) =>
        rec({
          system_prompt_hash: null,
          input_tokens: 12_000 + i * 200,
          metadata: { service: "x" },
        })
      ),
    ];
    expect(deadWeight.detect(ctx(records))).toBeNull();
  });

  it("does not fire when the group already uses caching", () => {
    const records = unhashedGroup(40, 20_000, 2_000).map((r, i) => ({
      ...r,
      cache_read_tokens: i % 3 === 0 ? 18_000 : 0,
    }));
    expect(deadWeight.detect(ctx(records))).toBeNull();
  });

  it("respects the ledger: tokens claimed by cache-miss are not re-claimed", () => {
    // Same records carry a hash → A1 claims them; A6 must skip hashed groups
    // entirely, and even via the ledger there is nothing left to claim.
    const records = Array.from({ length: 30 }, () =>
      rec({ system_prompt_hash: "shared", input_tokens: 20_000, metadata: { service: "y" } })
    );
    const context = ctx(records, { ledger: new TokenLedger() });
    const a1 = cacheMiss.detect(context);
    expect(a1).not.toBeNull();
    expect(deadWeight.detect(context)).toBeNull();
  });
});

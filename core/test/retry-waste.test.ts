import { describe, it, expect } from "vitest";
import { retryWaste } from "../src/analyzers/retry-waste.js";
import { rec, ctx } from "./helpers.js";

describe("A4 retry-waste", () => {
  it("fires on identical full_prompt_hash within 60s", () => {
    const base = Date.UTC(2026, 4, 12, 9);
    const records = [
      rec({ full_prompt_hash: "dup", ts: base, input_tokens: 10_000, output_tokens: 300 }),
      rec({ full_prompt_hash: "dup", ts: base + 5_000, input_tokens: 10_000, output_tokens: 300 }),
      rec({ full_prompt_hash: "dup", ts: base + 12_000, input_tokens: 10_000, output_tokens: 300 }),
    ];
    const finding = retryWaste.detect(ctx(records));
    expect(finding).not.toBeNull();
    // 2 duplicates × (10000×$3 + 300×$15)/MTok
    expect(finding!.wasted_usd).toBeCloseTo((2 * (10_000 * 3 + 300 * 15)) / 1e6, 6);
    expect(finding!.confidence).toBe("high");
  });

  it("fires on identical hash re-sent after a >=400 status", () => {
    const base = Date.UTC(2026, 4, 12, 9);
    const records = [
      rec({ full_prompt_hash: "retry", ts: base, status: 529, output_tokens: 0, input_tokens: 5000 }),
      rec({ full_prompt_hash: "retry", ts: base + 300_000, status: 200, input_tokens: 5000, output_tokens: 200 }),
    ];
    const finding = retryWaste.detect(ctx(records));
    expect(finding).not.toBeNull();
    expect(finding!.wasted_usd).toBeCloseTo((5000 * 3 + 200 * 15) / 1e6, 6);
  });

  it("does not fire on identical hashes far apart with success statuses", () => {
    const base = Date.UTC(2026, 4, 12, 9);
    const records = [
      rec({ full_prompt_hash: "ok", ts: base }),
      rec({ full_prompt_hash: "ok", ts: base + 3_600_000 }),
    ];
    expect(retryWaste.detect(ctx(records))).toBeNull();
  });

  it("does not fire without full prompt hashes", () => {
    const records = [rec({}), rec({})];
    expect(retryWaste.detect(ctx(records))).toBeNull();
  });
});

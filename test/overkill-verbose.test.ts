import { describe, it, expect } from "vitest";
import { modelOverkill } from "../src/analyzers/model-overkill.js";
import { verboseOutput } from "../src/analyzers/verbose-output.js";
import { rec, ctx } from "./helpers.js";

describe("A3 model-overkill", () => {
  it("fires on short-output frontier-model calls and labels savings 'up to'", () => {
    const records = Array.from({ length: 50 }, (_, i) =>
      rec({
        model: "claude-opus-4-1",
        input_tokens: 1500,
        output_tokens: 40,
        full_prompt_hash: `c${i}`,
      })
    );
    const finding = modelOverkill.detect(ctx(records));
    expect(finding).not.toBeNull();
    expect(finding!.upper_bound).toBe(true);
    expect(finding!.confidence).toBe("medium");
    // vs cheapest anthropic budget tier (claude-haiku-3-5: $0.80/$4.00)
    const perCall = (1500 * (15 - 0.8) + 40 * (75 - 4)) / 1e6;
    expect(finding!.wasted_usd).toBeCloseTo(50 * perCall, 4);
  });

  it("does not fire on budget models", () => {
    const records = Array.from({ length: 50 }, () =>
      rec({ model: "claude-haiku-4-5", input_tokens: 1500, output_tokens: 40 })
    );
    expect(modelOverkill.detect(ctx(records))).toBeNull();
  });

  it("does not fire on long outputs or big inputs or tool use", () => {
    const records = [
      rec({ model: "claude-opus-4-1", input_tokens: 1500, output_tokens: 900 }),
      rec({ model: "claude-opus-4-1", input_tokens: 8000, output_tokens: 40 }),
      rec({ model: "claude-opus-4-1", input_tokens: 1500, output_tokens: 40, metadata: { tools: ["search"] } }),
    ];
    expect(modelOverkill.detect(ctx(records))).toBeNull();
  });
});

describe("A5 verbose-output", () => {
  it("fires on uncapped calls above the model's p90", () => {
    const records = [
      ...Array.from({ length: 95 }, () => rec({ output_tokens: 300, max_tokens_set: true })),
      ...Array.from({ length: 5 }, () => rec({ output_tokens: 5000, max_tokens_set: false })),
    ];
    const finding = verboseOutput.detect(ctx(records));
    expect(finding).not.toBeNull();
    expect(finding!.confidence).toBe("low");
    // p75 = 300 → waste = 5 × (5000−300) × $15/MTok
    expect(finding!.wasted_usd).toBeCloseTo((5 * 4700 * 15) / 1e6, 4);
  });

  it("does not fire when max_tokens is set everywhere", () => {
    const records = [
      ...Array.from({ length: 95 }, () => rec({ output_tokens: 300 })),
      ...Array.from({ length: 5 }, () => rec({ output_tokens: 5000 })),
    ];
    expect(verboseOutput.detect(ctx(records))).toBeNull();
  });
});

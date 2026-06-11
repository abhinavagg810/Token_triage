import { describe, it, expect } from "vitest";
import { contextBloat } from "../src/analyzers/context-bloat.js";
import { rec, ctx } from "./helpers.js";

function bloatedSession(id: string, turns = 8, firstInput = 3000, delta = 4000) {
  const base = Date.UTC(2026, 4, 2, 9);
  return Array.from({ length: turns }, (_, i) =>
    rec({
      session_id: id,
      input_tokens: firstInput + i * delta,
      ts: base + i * 30_000,
    })
  );
}

describe("A2 context-bloat", () => {
  it("fires on sessions growing >3x over >=5 turns", () => {
    const records = bloatedSession("s1");
    const finding = contextBloat.detect(ctx(records));
    expect(finding).not.toBeNull();
    expect(finding!.confidence).toBe("high");
    // baseline = 3000 + 2×4000 = 11000; waste = Σ max(0, input−11000)
    const wasteTokens = records.reduce((a, r) => a + Math.max(0, r.input_tokens - 11_000), 0);
    expect(finding!.wasted_usd).toBeCloseTo((wasteTokens * 3) / 1e6, 4);
    const sessions = (finding!.details!.worst_sessions as { id: string }[]);
    expect(sessions[0]!.id).toBe("s1");
  });

  it("does not fire on short sessions", () => {
    const records = bloatedSession("s1", 4);
    expect(contextBloat.detect(ctx(records))).toBeNull();
  });

  it("does not fire on flat sessions (growth <= 3x)", () => {
    const records = bloatedSession("s1", 10, 5000, 100);
    expect(contextBloat.detect(ctx(records))).toBeNull();
  });

  it("ranks the worst sessions first", () => {
    const records = [...bloatedSession("small", 6, 2000, 3000), ...bloatedSession("big", 14, 4000, 5000)];
    const finding = contextBloat.detect(ctx(records));
    const sessions = (finding!.details!.worst_sessions as { id: string }[]);
    expect(sessions[0]!.id).toBe("big");
  });
});

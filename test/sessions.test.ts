import { describe, it, expect } from "vitest";
import { reconstructSessions } from "../src/core/sessions.js";
import { rec } from "./helpers.js";

describe("session reconstruction", () => {
  it("groups by explicit session_id", () => {
    const records = [
      rec({ session_id: "s1" }),
      rec({ session_id: "s1" }),
      rec({ session_id: "s2" }),
    ];
    const sessions = reconstructSessions(records);
    const explicit = sessions.filter((s) => !s.inferred);
    expect(explicit).toHaveLength(2);
    expect(explicit.find((s) => s.id === "s1")?.records).toHaveLength(2);
  });

  it("infers sessions from same hash + growing input + <30min gaps", () => {
    const base = Date.UTC(2026, 4, 1, 12);
    const records = [
      rec({ ts: base, input_tokens: 1000, system_prompt_hash: "h1" }),
      rec({ ts: base + 60_000, input_tokens: 2500, system_prompt_hash: "h1" }),
      rec({ ts: base + 120_000, input_tokens: 4200, system_prompt_hash: "h1" }),
    ];
    const sessions = reconstructSessions(records);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.inferred).toBe(true);
    expect(sessions[0]!.records).toHaveLength(3);
  });

  it("splits on >30min gaps and on input-token decreases", () => {
    const base = Date.UTC(2026, 4, 1, 12);
    const records = [
      rec({ ts: base, input_tokens: 1000, system_prompt_hash: "h1" }),
      rec({ ts: base + 60_000, input_tokens: 2500, system_prompt_hash: "h1" }),
      // gap of 2 hours → new session
      rec({ ts: base + 2 * 3_600_000, input_tokens: 3000, system_prompt_hash: "h1" }),
      // input decreases → new session
      rec({ ts: base + 2 * 3_600_000 + 60_000, input_tokens: 900, system_prompt_hash: "h1" }),
    ];
    const sessions = reconstructSessions(records);
    // Singleton groups are dropped; only the first pair forms a session.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.records).toHaveLength(2);
  });

  it("respects --no-session-inference", () => {
    const base = Date.UTC(2026, 4, 1, 12);
    const records = [
      rec({ ts: base, input_tokens: 1000, system_prompt_hash: "h1" }),
      rec({ ts: base + 60_000, input_tokens: 2500, system_prompt_hash: "h1" }),
    ];
    expect(reconstructSessions(records, { inference: false })).toHaveLength(0);
  });
});

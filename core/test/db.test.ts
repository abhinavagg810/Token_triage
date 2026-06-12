import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { analyze } from "../src/core/engine.js";
import { exportDb } from "../src/report/db.js";
import { rec, testPricing } from "./helpers.js";
import type { SkipStats } from "../src/core/schema.js";

const noSkips = (): SkipStats => ({ total: 10, skipped: 0, missingFields: new Map() });

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tt-db-")), "audit.db");
}

describe("--db SQLite export", () => {
  it("exports requests, sessions, findings, daily_spend and meta", async () => {
    const base = Date.UTC(2026, 4, 12, 9);
    const records = [
      // a cache-miss group so findings is non-empty
      ...Array.from({ length: 12 }, (_, i) =>
        rec({
          id: `c${i}`,
          ts: base + i * 3_600_000,
          system_prompt_hash: "shared",
          input_tokens: 4_000,
          metadata: { service: "copilot" },
        })
      ),
      // an explicit session
      ...Array.from({ length: 3 }, (_, i) =>
        rec({ id: `s${i}`, ts: base + i * 60_000, session_id: "sess_1", input_tokens: 1_000 + i })
      ),
    ];
    const pricing = testPricing();
    const result = analyze(records, pricing, noSkips());
    const dbPath = tmpDb();
    const counts = await exportDb(result, pricing, dbPath);

    expect(counts.requests).toBe(15);
    expect(counts.findings).toBeGreaterThanOrEqual(1);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const reqCount = db.prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number };
      expect(reqCount.n).toBe(15);

      const svc = db
        .prepare("SELECT service, cost_usd FROM requests WHERE id='c0'")
        .get() as { service: string; cost_usd: number };
      expect(svc.service).toBe("copilot");
      expect(svc.cost_usd).toBeCloseTo((4000 * 3 + 300 * 15) / 1e6, 8);

      const sess = db.prepare("SELECT * FROM sessions WHERE id='sess_1'").get() as {
        turns: number;
        inferred: number;
      };
      expect(sess.turns).toBe(3);
      expect(sess.inferred).toBe(0);

      const meta = db
        .prepare("SELECT value FROM meta WHERE key='schema_version'")
        .get() as { value: string };
      expect(meta.value).toBe("1");

      // Privacy: the schema must have no column that could carry prompt bodies.
      const cols = db.prepare("SELECT name FROM pragma_table_info('requests')").all() as {
        name: string;
      }[];
      const names = cols.map((c) => c.name);
      expect(names).not.toContain("request_body");
      expect(names).not.toContain("prompt");
      expect(names).not.toContain("content");
      expect(names.filter((n) => n.includes("hash"))).toEqual([
        "system_prompt_hash",
        "full_prompt_hash",
      ]);

      // agent_runs exists and is empty (the agent service fills it)
      const runs = db.prepare("SELECT COUNT(*) AS n FROM agent_runs").get() as { n: number };
      expect(runs.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("re-export overwrites the previous file", async () => {
    const pricing = testPricing();
    const dbPath = tmpDb();
    const r1 = analyze([rec({ id: "only" })], pricing, noSkips());
    await exportDb(r1, pricing, dbPath);
    const r2 = analyze([rec({ id: "a" }), rec({ id: "b" })], pricing, noSkips());
    const counts = await exportDb(r2, pricing, dbPath);
    expect(counts.requests).toBe(2);
  });
});

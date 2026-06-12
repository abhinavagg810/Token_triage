import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { analyze } from "../src/core/engine.js";
import { exportDb } from "../src/report/db.js";
import { startServer } from "../src/serve/server.js";
import { rec, testPricing } from "./helpers.js";
import type { SkipStats } from "../src/core/schema.js";

const noSkips = (): SkipStats => ({ total: 10, skipped: 0, missingFields: new Map() });

let server: http.Server;
let base: string;

beforeAll(async () => {
  const baseTs = Date.UTC(2026, 4, 12, 9);
  const records = [
    // cache-miss group so findings exist
    ...Array.from({ length: 15 }, (_, i) =>
      rec({
        id: `c${i}`,
        ts: baseTs + i * 3_600_000,
        system_prompt_hash: "shared",
        input_tokens: 4_000,
        metadata: { service: "copilot" },
      })
    ),
    // a second day + service + model for filter tests
    ...Array.from({ length: 5 }, (_, i) =>
      rec({
        id: `g${i}`,
        ts: baseTs + 86_400_000 + i * 60_000,
        model: "gpt-4o",
        provider: "openai",
        input_tokens: 2_000,
        metadata: { service: "search" },
      })
    ),
    // an explicit session
    ...Array.from({ length: 3 }, (_, i) =>
      rec({ id: `s${i}`, ts: baseTs + i * 60_000, session_id: "sess_1", input_tokens: 1_000 + i })
    ),
  ];
  const pricing = testPricing();
  const result = analyze(records, pricing, noSkips());
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tt-serve-")), "audit.db");
  await exportDb(result, pricing, dbPath);

  server = await startServer({ dbPath, port: 0, host: "127.0.0.1" });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
});

describe("tokentriage serve", () => {
  it("serves a self-contained dashboard at /", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("TokenTriage");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toContain("https://cdn");
  });

  it("/api/meta returns totals and counts", async () => {
    const { meta, counts } = await (await fetch(`${base}/api/meta`)).json();
    expect(meta.schema_version).toBe("1");
    expect(Number(meta.total_spend_usd)).toBeGreaterThan(0);
    expect(counts.requests).toBe(23);
    expect(counts.sessions).toBeGreaterThanOrEqual(1);
  });

  it("/api/findings returns parsed evidence and fix blocks", async () => {
    const findings = await (await fetch(`${base}/api/findings`)).json();
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].analyzer_id).toBe("cache-miss");
    expect(Array.isArray(findings[0].evidence)).toBe(true);
    expect(findings[0].fix.summary.length).toBeGreaterThan(0);
    expect(findings[0].evidence_json).toBeUndefined();
  });

  it("/api/models and /api/services aggregate spend", async () => {
    const models = await (await fetch(`${base}/api/models`)).json();
    const names = models.map((m: { model: string }) => m.model);
    expect(names).toContain("claude-sonnet-4-5");
    expect(names).toContain("gpt-4o");

    const services = await (await fetch(`${base}/api/services`)).json();
    const svc = Object.fromEntries(services.map((s: { service: string; requests: number }) => [s.service, s.requests]));
    expect(svc["copilot"]).toBe(15);
    expect(svc["search"]).toBe(5);
    expect(svc["(none)"]).toBe(3);
  });

  it("/api/requests supports filtering and pagination", async () => {
    const all = await (await fetch(`${base}/api/requests?limit=10`)).json();
    expect(all.total).toBe(23);
    expect(all.rows.length).toBe(10);

    const filtered = await (await fetch(`${base}/api/requests?service=search`)).json();
    expect(filtered.total).toBe(5);
    expect(filtered.rows.every((r: { model: string }) => r.model === "gpt-4o")).toBe(true);

    const page2 = await (await fetch(`${base}/api/requests?limit=10&offset=20`)).json();
    expect(page2.rows.length).toBe(3);
  });

  it("/api/daily respects date-range filters", async () => {
    const all = await (await fetch(`${base}/api/daily`)).json();
    expect(all.length).toBe(2);
    const one = await (await fetch(`${base}/api/daily?start=2026-05-13&end=2026-05-13`)).json();
    expect(one.length).toBe(1);
    expect(one[0].date).toBe("2026-05-13");
  });

  it("/api/sessions ranks by the requested metric", async () => {
    const rows = await (await fetch(`${base}/api/sessions?metric=turns&limit=5`)).json();
    expect(rows[0].id).toBe("sess_1");
    expect(rows[0].turns).toBe(3);
  });

  it("responses never contain prompt-content fields", async () => {
    for (const p of ["/api/requests", "/api/findings", "/api/sessions"]) {
      const text = await (await fetch(`${base}${p}`)).text();
      expect(text).not.toContain("request_body");
      expect(text).not.toContain("prompt_text");
    }
  });

  it("unknown routes 404 and bad params don't crash", async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    expect((await fetch(`${base}/../etc/passwd`)).status).toBe(404);
    const res = await fetch(`${base}/api/requests?limit=99999&offset=-5`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.limit).toBeLessThanOrEqual(200);
    expect(data.offset).toBe(0);
  });
});

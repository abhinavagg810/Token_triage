import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startWatch, type WatchHandle } from "../src/serve/watch.js";

let upstream: http.Server;
let watch: WatchHandle;
let proxyBase: string;
let dashBase: string;

beforeAll(async () => {
  // Fake Anthropic upstream: fixed usage per call, shared system prompt shape.
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_${Math.random().toString(36).slice(2)}`,
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 4000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        })
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as { port: number }).port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-watch-"));
  watch = await startWatch({
    host: "127.0.0.1",
    proxyPort: 0,
    dashboardPort: 0,
    captureFile: path.join(dir, "capture.jsonl"),
    dbPath: path.join(dir, "live.db"),
    intervalMs: 250,
    anthropicUpstream: `http://127.0.0.1:${upPort}`,
  });
  proxyBase = `http://127.0.0.1:${(watch.proxy.address() as { port: number }).port}`;
  dashBase = `http://127.0.0.1:${(watch.dashboard.address() as { port: number }).port}`;
});

afterAll(async () => {
  await watch?.stop();
  upstream?.close();
});

async function meta(): Promise<Record<string, string>> {
  return (await (await fetch(`${dashBase}/api/meta`)).json()).meta;
}

describe("tokentriage watch (one-command live mode)", () => {
  it("starts with an empty 'waiting for traffic' export", async () => {
    const m = await meta();
    expect(m.schema_version).toBe("1");
    expect(Number(m.request_count)).toBe(0);
  });

  it("traffic through the proxy is analyzed automatically and findings appear", async () => {
    // 12 calls sharing a system prompt, uncached → cache-miss must fire.
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${proxyBase}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tokentriage-service": "live-test" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 256,
          system: "the same big system prompt every time",
          messages: [{ role: "user", content: `q${i}` }],
        }),
      });
      expect(res.status).toBe(200);
    }

    // Wait for a re-analysis cycle to pick the captures up (interval 250ms).
    let m: Record<string, string> = {};
    for (let tries = 0; tries < 40; tries++) {
      await sleep(250);
      m = await meta();
      if (Number(m.request_count) >= 12) break;
    }
    expect(Number(m.request_count)).toBe(12);
    expect(Number(m.total_spend_usd)).toBeGreaterThan(0);

    const findings = await (await fetch(`${dashBase}/api/findings`)).json();
    const ids = findings.map((f: { analyzer_id: string }) => f.analyzer_id);
    expect(ids).toContain("cache-miss");

    const services = await (await fetch(`${dashBase}/api/services`)).json();
    expect(services[0].service).toBe("live-test");
    expect(services[0].requests).toBe(12);
  });

  it("keeps analyzing as more traffic arrives (hot-reloaded export)", async () => {
    const before = Number((await meta()).request_count);
    await fetch(`${proxyBase}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 256,
        messages: [{ role: "user", content: "one more" }],
      }),
    });
    let after = before;
    for (let tries = 0; tries < 40; tries++) {
      await sleep(250);
      after = Number((await meta()).request_count);
      if (after > before) break;
    }
    expect(after).toBe(before + 1);
  });
});

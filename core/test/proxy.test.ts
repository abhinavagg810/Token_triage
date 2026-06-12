import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startProxy, extractUsage } from "../src/proxy/proxy.js";
import { sha256 } from "../src/ingest/hash.js";
import { ingestGenericJsonl } from "../src/ingest/jsonl.js";

let upstream: http.Server;
let proxy: http.Server;
let proxyBase: string;
let capturePath: string;
let seenUpstreamHeaders: http.IncomingHttpHeaders = {};

const SECRET_PROMPT = "TOP-SECRET system prompt: the launch code is 1234.";

beforeAll(async () => {
  // Fake provider serving both Anthropic- and OpenAI-shaped endpoints.
  upstream = http.createServer((req, res) => {
    seenUpstreamHeaders = req.headers;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (req.url?.startsWith("/v1/messages") && body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          'data: {"type":"message_start","message":{"id":"msg_s1","model":"claude-sonnet-4-5","usage":{"input_tokens":900,"cache_read_input_tokens":2000,"cache_creation_input_tokens":0,"output_tokens":1}}}\n\n'
        );
        res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n');
        res.write('data: {"type":"message_delta","usage":{"output_tokens":42}}\n\n');
        res.end("data: [DONE]\n\n");
      } else if (req.url?.startsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_j1",
            model: "claude-sonnet-4-5",
            content: [{ type: "text", text: "answer" }],
            usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          })
        );
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl_1",
            model: "gpt-4o-2024-11-20",
            choices: [{ message: { content: "answer" } }],
            usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 600 } },
          })
        );
      }
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as { port: number }).port;

  capturePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tt-proxy-")), "capture.jsonl");
  proxy = await startProxy({
    port: 0,
    host: "127.0.0.1",
    outPath: capturePath,
    anthropicUpstream: `http://127.0.0.1:${upPort}`,
    openaiUpstream: `http://127.0.0.1:${upPort}`,
  });
  proxyBase = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
});

afterAll(() => {
  proxy?.close();
  upstream?.close();
});

async function captured(): Promise<Record<string, unknown>[]> {
  await sleep(150); // appendFile is async fire-and-forget
  return fs
    .readFileSync(capturePath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("tokentriage proxy", () => {
  it("passes Anthropic JSON responses through untouched and captures usage + hashes", async () => {
    const res = await fetch(`${base()}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-SECRETKEY",
        "x-tokentriage-service": "support-copilot",
        "x-tokentriage-session": "sess_42",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        system: SECRET_PROMPT,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const body = await res.json();
    expect(body.id).toBe("msg_j1"); // byte-for-byte passthrough
    expect(body.content[0].text).toBe("answer");

    const records = await captured();
    const rec = records.find((r) => r.id === "msg_j1")!;
    expect(rec.provider).toBe("anthropic");
    expect(rec.input_tokens).toBe(1200);
    expect(rec.output_tokens).toBe(300);
    expect(rec.session_id).toBe("sess_42");
    expect((rec.metadata as { service: string }).service).toBe("support-copilot");
    expect(rec.max_tokens_set).toBe(true);
    expect(rec.system_prompt_hash).toBe(sha256(SECRET_PROMPT));
    expect(rec.status).toBe(200);
  });

  it("strips x-tokentriage-* headers before forwarding, keeps auth headers", async () => {
    expect(seenUpstreamHeaders["x-tokentriage-service"]).toBeUndefined();
    expect(seenUpstreamHeaders["x-tokentriage-session"]).toBeUndefined();
    expect(seenUpstreamHeaders["x-api-key"]).toBe("sk-ant-SECRETKEY");
  });

  it("captures usage from Anthropic SSE streams without breaking the stream", async () => {
    const res = await fetch(`${base()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const text = await res.text();
    expect(text).toContain("message_start"); // stream reached the client intact
    expect(text).toContain("data: [DONE]");

    const rec = (await captured()).find((r) => r.id === "msg_s1")!;
    expect(rec.input_tokens).toBe(900);
    expect(rec.cache_read_tokens).toBe(2000);
    expect(rec.output_tokens).toBe(42); // from message_delta
  });

  it("routes non-Messages paths to OpenAI and splits cached prompt tokens", async () => {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-OPENAIKEY" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      }),
    });
    expect((await res.json()).id).toBe("chatcmpl_1");

    const rec = (await captured()).find((r) => r.id === "chatcmpl_1")!;
    expect(rec.provider).toBe("openai");
    // prompt_tokens 1000 includes 600 cached → canonical split
    expect(rec.input_tokens).toBe(400);
    expect(rec.cache_read_tokens).toBe(600);
    expect(rec.output_tokens).toBe(50);
    expect(rec.model).toBe("gpt-4o-2024-11-20");
  });

  it("privacy: the capture file never contains prompt content or API keys", async () => {
    const raw = fs.readFileSync(capturePath, "utf-8");
    expect(raw).not.toContain("TOP-SECRET");
    expect(raw).not.toContain("launch code");
    expect(raw).not.toContain("SECRETKEY");
    expect(raw).not.toContain("OPENAIKEY");
    expect(raw).not.toContain("hello"); // user message content
  });

  it("the capture file is directly ingestable as generic JSONL", async () => {
    const { records, skips } = ingestGenericJsonl(fs.readFileSync(capturePath, "utf-8"));
    expect(skips.skipped).toBe(0);
    expect(records.length).toBeGreaterThanOrEqual(3);
    expect(records.every((r) => r.input_tokens >= 0 && r.model.length > 0)).toBe(true);
  });
});

describe("extractUsage", () => {
  it("returns zeros on non-JSON bodies instead of throwing", () => {
    const u = extractUsage("internal server error", "text/plain", "anthropic");
    expect(u.input_tokens).toBe(0);
    expect(u.output_tokens).toBe(0);
  });

  it("handles the OpenAI Responses API usage shape", () => {
    const u = extractUsage(
      JSON.stringify({
        id: "resp_1",
        model: "gpt-5",
        usage: { input_tokens: 500, output_tokens: 80, input_tokens_details: { cached_tokens: 200 } },
      }),
      "application/json",
      "openai"
    );
    expect(u.input_tokens).toBe(300);
    expect(u.cache_read_tokens).toBe(200);
    expect(u.output_tokens).toBe(80);
  });
});

function base(): string {
  return proxyBase;
}

describe("test-traffic helper", () => {
  it("sends N requests through the proxy and they are captured with the test-traffic service tag", async () => {
    const { sendTestTraffic } = await import("../src/proxy/test-traffic.js");
    const { ok, failed } = await sendTestTraffic({
      proxyUrl: base(),
      apiKey: "sk-ant-fake",
      requests: 3,
      model: "claude-haiku-4-5",
    });
    expect(ok).toBe(3);
    expect(failed).toBe(0);
    const records = await captured();
    const tagged = records.filter(
      (r) => (r.metadata as { service?: string })?.service === "test-traffic"
    );
    expect(tagged.length).toBe(3);
  });

  it("fails fast with a clear count when the proxy is not running", async () => {
    const { sendTestTraffic } = await import("../src/proxy/test-traffic.js");
    const { ok, failed } = await sendTestTraffic({
      proxyUrl: "http://127.0.0.1:1", // nothing listens here
      apiKey: "sk-ant-fake",
      requests: 5,
      model: "claude-haiku-4-5",
    });
    expect(ok).toBe(0);
    expect(failed).toBe(1); // stops on first connection failure instead of retrying 5x
  });
});

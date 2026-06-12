import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { URL } from "node:url";
import { hashRequestBody } from "../ingest/hash.js";

/**
 * Phase 3 — `tokentriage proxy`: real-time capture.
 *
 * A local pass-through proxy for the Anthropic and OpenAI APIs. Point your
 * SDK at it (ANTHROPIC_BASE_URL / OPENAI_BASE_URL) and every request is
 * forwarded byte-for-byte while usage METADATA is appended to a generic-JSONL
 * capture file that `tokentriage analyze` ingests directly.
 *
 * Privacy invariants (same as the rest of the tool):
 *  - request bodies are parsed IN MEMORY for model/usage/hashes, then discarded
 *  - prompt/response content is never written anywhere
 *  - API keys pass through to the provider and are never logged
 *  - the proxy binds to 127.0.0.1 by default and makes no calls except to the
 *    provider the client asked for
 */
export interface ProxyOptions {
  port: number;
  host: string;
  outPath: string;
  /** Override upstreams (used by tests; defaults are the real APIs). */
  anthropicUpstream?: string;
  openaiUpstream?: string;
  /** Called after each captured record (logging hook). */
  onCapture?: (record: Record<string, unknown>) => void;
}

const MAX_CAPTURE_BYTES = 5 * 1024 * 1024; // stop buffering response copies past this; passthrough continues

/** Headers the proxy consumes for attribution and must NOT forward upstream. */
const LOCAL_HEADERS = ["x-tokentriage-session", "x-tokentriage-service"];

export async function startProxy(options: ProxyOptions): Promise<http.Server> {
  const anthropicUpstream = new URL(options.anthropicUpstream ?? "https://api.anthropic.com");
  const openaiUpstream = new URL(options.openaiUpstream ?? "https://api.openai.com");
  let counter = 0;

  function appendRecord(record: Record<string, unknown>): void {
    fs.appendFile(options.outPath, JSON.stringify(record) + "\n", () => {});
    options.onCapture?.(record);
  }

  const server = http.createServer((req, res) => {
    const startedAt = Date.now();
    const path = req.url ?? "/";
    // Route by API shape: the Messages API is Anthropic, everything else OpenAI.
    const upstream = path.startsWith("/v1/messages") ? anthropicUpstream : openaiUpstream;
    const provider = upstream === anthropicUpstream ? "anthropic" : "openai";

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const requestBody = Buffer.concat(chunks);

      // Parse in memory for model + hashes + attribution; discarded after this scope.
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(requestBody.toString("utf-8")) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      const hashes = parsed
        ? hashRequestBody(parsed)
        : { system_prompt_hash: null, full_prompt_hash: null, max_tokens_set: null };
      const sessionId = headerValue(req, "x-tokentriage-session");
      const service = headerValue(req, "x-tokentriage-service");

      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(req.headers)) {
        const lower = name.toLowerCase();
        if (lower === "host" || lower === "content-length" || LOCAL_HEADERS.includes(lower)) continue;
        headers[name] = value;
      }
      headers["host"] = upstream.host;
      headers["content-length"] = String(requestBody.length);

      const transport = upstream.protocol === "https:" ? https : http;
      const upstreamReq = transport.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
          method: req.method,
          path,
          headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);

          // Tee: stream bytes straight through to the client while keeping a
          // bounded copy for usage extraction.
          let captured = Buffer.alloc(0);
          upstreamRes.on("data", (chunk: Buffer) => {
            res.write(chunk);
            if (captured.length < MAX_CAPTURE_BYTES) {
              captured = Buffer.concat([captured, chunk]);
            }
          });
          upstreamRes.on("end", () => {
            res.end();
            try {
              const usage = extractUsage(
                captured.toString("utf-8"),
                String(upstreamRes.headers["content-type"] ?? ""),
                provider
              );
              const model =
                usage.model ?? (parsed && typeof parsed.model === "string" ? parsed.model : "unknown");
              appendRecord({
                id: usage.id ?? `prx_${Date.now()}_${counter++}`,
                timestamp: new Date(startedAt).toISOString(),
                provider,
                model,
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_read_tokens: usage.cache_read_tokens,
                cache_write_tokens: usage.cache_write_tokens,
                status: upstreamRes.statusCode ?? 0,
                latency_ms: Date.now() - startedAt,
                session_id: sessionId,
                system_prompt_hash: hashes.system_prompt_hash,
                full_prompt_hash: hashes.full_prompt_hash,
                max_tokens_set: hashes.max_tokens_set ?? true,
                metadata: service ? { service } : {},
              });
            } catch {
              // capture must never break the proxied call
            }
          });
        }
      );

      upstreamReq.on("error", (err) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `upstream error: ${err.message}` }));
      });
      upstreamReq.end(requestBody);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  return server;
}

function headerValue(req: http.IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

interface ExtractedUsage {
  id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/**
 * Pull token usage out of a JSON or SSE response.
 *
 * Anthropic reports input_tokens EXCLUDING cache reads/writes (separate
 * fields) — direct mapping. OpenAI's prompt_tokens INCLUDES cached tokens,
 * so we split: input = prompt − cached, cache_read = cached, matching the
 * canonical schema's cost semantics.
 */
export function extractUsage(body: string, contentType: string, provider: string): ExtractedUsage {
  const out: ExtractedUsage = {
    id: null,
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };

  const applyAnthropic = (msg: Record<string, unknown>): void => {
    const usage = (msg.usage ?? {}) as Record<string, unknown>;
    if (typeof msg.id === "string") out.id = msg.id;
    if (typeof msg.model === "string") out.model = msg.model;
    if (typeof usage.input_tokens === "number") out.input_tokens = usage.input_tokens;
    if (typeof usage.output_tokens === "number") out.output_tokens = usage.output_tokens;
    if (typeof usage.cache_read_input_tokens === "number") out.cache_read_tokens = usage.cache_read_input_tokens;
    if (typeof usage.cache_creation_input_tokens === "number") out.cache_write_tokens = usage.cache_creation_input_tokens;
  };

  const applyOpenAi = (msg: Record<string, unknown>): void => {
    const usage = (msg.usage ?? {}) as Record<string, unknown> | null;
    if (typeof msg.id === "string") out.id = msg.id;
    if (typeof msg.model === "string") out.model = msg.model;
    if (!usage) return;
    const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
    const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
    const cached = typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
    out.input_tokens = Math.max(0, prompt - cached);
    out.cache_read_tokens = cached;
    if (typeof usage.completion_tokens === "number") out.output_tokens = usage.completion_tokens;
    // Responses API shape
    if (typeof usage.input_tokens === "number") {
      const inputDetails = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
      const cachedIn = typeof inputDetails.cached_tokens === "number" ? inputDetails.cached_tokens : 0;
      out.input_tokens = Math.max(0, usage.input_tokens - cachedIn);
      out.cache_read_tokens = cachedIn;
    }
    if (typeof usage.output_tokens === "number") out.output_tokens = usage.output_tokens;
  };

  const apply = provider === "anthropic" ? applyAnthropic : applyOpenAi;

  if (contentType.includes("text/event-stream")) {
    for (const line of body.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (provider === "anthropic") {
        // message_start carries the message (input usage); message_delta carries output usage
        if (evt.type === "message_start" && evt.message) {
          applyAnthropic(evt.message as Record<string, unknown>);
        } else if (evt.type === "message_delta" && evt.usage) {
          const usage = evt.usage as Record<string, unknown>;
          if (typeof usage.output_tokens === "number") out.output_tokens = usage.output_tokens;
        }
      } else {
        // OpenAI: the final chunk carries usage when stream_options.include_usage is set
        applyOpenAi(evt);
      }
    }
    return out;
  }

  try {
    apply(JSON.parse(body) as Record<string, unknown>);
  } catch {
    /* non-JSON response (errors, etc.) — record zeros */
  }
  return out;
}

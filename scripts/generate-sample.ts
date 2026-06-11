/**
 * Generates samples/sample-logs.jsonl — the "Meridian Labs" synthetic 30-day
 * dataset (PRD §12.5). A 4-dev team running a support copilot + an agent
 * pipeline, with deliberate waste patterns baked in so every analyzer fires:
 *
 *  - A1 cache-miss:    copilot sends a large static prefix uncached on every call
 *  - A2 context-bloat: agent sessions resend full history, input balloons per turn
 *  - A3 model-overkill: sentiment classification (tiny outputs) on claude-opus-4-1
 *  - A4 retry-waste:   a bug window on day 12 triple-fires webhook calls for 6 hours
 *  - A5 verbose-output: report-writer service has no max_tokens and rambles
 *
 * Plus well-behaved traffic (properly cached endpoints, budget models) so the
 * waste percentages stay realistic. Deterministic via seeded PRNG.
 *
 * Run: npm run generate-sample
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "samples", "sample-logs.jsonl");

// --- deterministic PRNG (mulberry32) ---
let seed = 0x5eed;
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function randInt(min: number, max: number): number {
  return Math.floor(min + rand() * (max - min + 1));
}
function pickDay(): number {
  return randInt(0, 29);
}
/** Business-hours-weighted time of day (ms offset into the day). */
function pickTimeOfDay(): number {
  const hour = rand() < 0.8 ? randInt(8, 19) : randInt(0, 23);
  return ((hour * 60 + randInt(0, 59)) * 60 + randInt(0, 59)) * 1000;
}

const START = Date.UTC(2026, 4, 1); // 1 May 2026
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

interface Rec {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  status: number;
  latency_ms: number;
  session_id: string | null;
  system_prompt_hash: string | null;
  full_prompt_hash: string | null;
  max_tokens_set: boolean;
  metadata: Record<string, unknown>;
}

const records: Rec[] = [];
let idCounter = 0;
function push(ts: number, partial: Omit<Rec, "id" | "timestamp">): Rec {
  const rec: Rec = { id: `req_${String(++idCounter).padStart(6, "0")}`, timestamp: new Date(ts).toISOString(), ...partial };
  records.push(rec);
  return rec;
}

// ---------------------------------------------------------------------------
// 1. Support copilot (A1 target): claude-sonnet-4-5, ~38K-token static prefix
//    (2.1K system prompt + product KB stuffed into context), never cached.
// ---------------------------------------------------------------------------
const COPILOT_SYS = sha("meridian-copilot-system-v3 + product knowledge base");
const COPILOT_PREFIX = 38_000;
for (let i = 0; i < 2400; i++) {
  const ts = START + pickDay() * 86_400_000 + pickTimeOfDay();
  const rec = push(ts, {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    input_tokens: COPILOT_PREFIX + randInt(80, 1200),
    output_tokens: randInt(150, 520),
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    status: 200,
    latency_ms: randInt(1800, 5200),
    session_id: null,
    system_prompt_hash: COPILOT_SYS,
    full_prompt_hash: sha(`copilot-${i}`),
    max_tokens_set: true,
    metadata: { service: "support-copilot" },
  });
  // Occasionally a 529 followed by an identical retry (A4 case b).
  if (i % 80 === 0) {
    rec.status = 529;
    rec.output_tokens = 0;
    push(ts + randInt(1500, 9000), {
      ...rec,
      status: 200,
      output_tokens: randInt(150, 520),
      latency_ms: randInt(1800, 5200),
    });
  }
}

// ---------------------------------------------------------------------------
// 2. HR agent pipeline (A2 target): 110 sessions, 14 turns, full history
//    resent every turn — input balloons ~3.5K → ~59K tokens.
// ---------------------------------------------------------------------------
const AGENT_SYS = sha("meridian-hr-agent-system-v1");
for (let s = 0; s < 110; s++) {
  const sessionStart = START + pickDay() * 86_400_000 + pickTimeOfDay();
  let input = randInt(3300, 3700);
  let ts = sessionStart;
  for (let turn = 0; turn < 14; turn++) {
    push(ts, {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      input_tokens: input,
      output_tokens: randInt(380, 520),
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      status: 200,
      latency_ms: randInt(2000, 6000),
      session_id: `sess_${String(s + 1).padStart(3, "0")}`,
      system_prompt_hash: AGENT_SYS,
      full_prompt_hash: sha(`agent-${s}-${turn}`),
      max_tokens_set: true,
      metadata: { agent: "hr-agent" },
    });
    input += randInt(3900, 4700); // full history + tool results resent
    ts += randInt(15_000, 55_000);
  }
}

// ---------------------------------------------------------------------------
// 3. Sentiment classifier (A3 target): ~35-token outputs on claude-opus-4-1.
//    No shared system hash (instruction inlined) so A1 doesn't claim it first.
// ---------------------------------------------------------------------------
for (let i = 0; i < 1100; i++) {
  const ts = START + pickDay() * 86_400_000 + pickTimeOfDay();
  push(ts, {
    provider: "anthropic",
    model: "claude-opus-4-1",
    input_tokens: randInt(1600, 1950),
    output_tokens: randInt(20, 55),
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    status: 200,
    latency_ms: randInt(600, 1800),
    session_id: null,
    system_prompt_hash: null,
    full_prompt_hash: sha(`classify-${i}`),
    max_tokens_set: true,
    metadata: { service: "sentiment-classifier" },
  });
}

// ---------------------------------------------------------------------------
// 4. Webhook document router (A4 target): big payloads on sonnet. Normal all
//    month, but a bug on day 12 triple-fires every call for 6 hours.
// ---------------------------------------------------------------------------
function webhookCall(hash: string): Omit<Rec, "id" | "timestamp"> {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    input_tokens: randInt(23_000, 27_000),
    output_tokens: randInt(220, 380),
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    status: 200,
    latency_ms: randInt(3000, 8000),
    session_id: null,
    system_prompt_hash: null,
    full_prompt_hash: hash,
    max_tokens_set: true,
    metadata: { service: "webhook-router" },
  };
}
// normal traffic: ~8/day
for (let d = 0; d < 30; d++) {
  for (let i = 0; i < 8; i++) {
    push(START + d * 86_400_000 + pickTimeOfDay(), webhookCall(sha(`webhook-${d}-${i}`)));
  }
}
// day-12 bug window: 09:00–15:00, one event every ~90s, each fired 3×
{
  const windowStart = START + 11 * 86_400_000 + 9 * 3_600_000;
  let ts = windowStart;
  let n = 0;
  while (ts < windowStart + 6 * 3_600_000) {
    const hash = sha(`webhook-bug-${n++}`);
    const base = webhookCall(hash);
    push(ts, base);
    push(ts + randInt(900, 4000), { ...base });
    push(ts + randInt(4500, 12_000), { ...base });
    ts += randInt(75_000, 105_000);
  }
}

// ---------------------------------------------------------------------------
// 5. Report writer (A5 target): claude-opus-4-1, NO max_tokens, rambles.
// ---------------------------------------------------------------------------
const REPORT_SYS = sha("meridian-report-writer-system-v2");
for (let i = 0; i < 300; i++) {
  const ts = START + pickDay() * 86_400_000 + pickTimeOfDay();
  const rambling = i % 5 === 0; // 60 of 300 calls ramble
  push(ts, {
    provider: "anthropic",
    model: "claude-opus-4-1",
    input_tokens: randInt(1100, 1400),
    output_tokens: rambling ? randInt(2200, 4500) : randInt(380, 820),
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    status: 200,
    latency_ms: randInt(4000, 20_000),
    session_id: null,
    system_prompt_hash: REPORT_SYS,
    full_prompt_hash: sha(`report-${i}`),
    max_tokens_set: false,
    metadata: { service: "report-writer" },
  });
}

// ---------------------------------------------------------------------------
// 6. Well-behaved traffic (base spend — analyzers should stay quiet here).
// ---------------------------------------------------------------------------
// FAQ bot: properly cached prompt on sonnet.
const FAQ_SYS = sha("meridian-faq-bot-system-v5");
for (let i = 0; i < 600; i++) {
  const ts = START + pickDay() * 86_400_000 + pickTimeOfDay();
  const rewrite = i % 90 === 0;
  push(ts, {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    input_tokens: randInt(250, 550),
    output_tokens: randInt(120, 280),
    cache_read_tokens: rewrite ? 0 : 3000,
    cache_write_tokens: rewrite ? 3000 : 0,
    status: 200,
    latency_ms: randInt(700, 2200),
    session_id: null,
    system_prompt_hash: FAQ_SYS,
    full_prompt_hash: sha(`faq-${i}`),
    max_tokens_set: true,
    metadata: { service: "faq-bot" },
  });
}
// Nightly batch evals on opus-4-5 with caching used correctly.
for (let i = 0; i < 1800; i++) {
  const day = pickDay();
  const ts = START + day * 86_400_000 + 2 * 3_600_000 + randInt(0, 2 * 3_600_000);
  push(ts, {
    provider: "anthropic",
    model: "claude-opus-4-5",
    input_tokens: randInt(13_000, 17_000),
    output_tokens: randInt(2000, 3000),
    cache_read_tokens: 45_000,
    cache_write_tokens: i % 100 === 0 ? 45_000 : 0,
    status: 200,
    latency_ms: randInt(8000, 30_000),
    session_id: null,
    system_prompt_hash: sha("meridian-eval-harness"),
    full_prompt_hash: sha(`eval-${i}`),
    max_tokens_set: true,
    metadata: { service: "batch-eval" },
  });
}
// RAG search on gpt-4o with automatic caching working.
const RAG_SYS = sha("meridian-search-rag-system");
for (let i = 0; i < 1000; i++) {
  const ts = START + pickDay() * 86_400_000 + pickTimeOfDay();
  push(ts, {
    provider: "openai",
    model: "gpt-4o-2024-11-20",
    input_tokens: randInt(1500, 2600),
    output_tokens: randInt(350, 750),
    cache_read_tokens: 18_000,
    cache_write_tokens: 0,
    status: 200,
    latency_ms: randInt(1500, 5000),
    session_id: null,
    system_prompt_hash: RAG_SYS,
    full_prompt_hash: sha(`rag-${i}`),
    max_tokens_set: true,
    metadata: { service: "search-rag" },
  });
}
// Internal chat on gpt-4o-mini (budget model, nothing to flag).
for (let i = 0; i < 400; i++) {
  const ts = START + pickDay() * 86_400_000 + pickTimeOfDay();
  push(ts, {
    provider: "openai",
    model: "gpt-4o-mini",
    input_tokens: randInt(800, 2400),
    output_tokens: randInt(150, 600),
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    status: 200,
    latency_ms: randInt(500, 2000),
    session_id: null,
    system_prompt_hash: sha("meridian-internal-chat"),
    full_prompt_hash: sha(`chat-${i}`),
    max_tokens_set: true,
    metadata: { service: "internal-chat" },
  });
}

// ---------------------------------------------------------------------------
records.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`Wrote ${records.length.toLocaleString()} records to ${OUT}`);

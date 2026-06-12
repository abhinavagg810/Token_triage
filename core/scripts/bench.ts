/**
 * NFR benchmark (PRD §6): 1M records analyzed in < 60s on a laptop,
 * stream-parsed. Generates a 1M-line generic JSONL file in the OS temp dir,
 * then times the full pipeline: streaming ingest → sessions → pricing →
 * all analyzers.
 *
 * Run: npx tsx scripts/bench.ts [record_count]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestPath } from "../src/ingest/index.js";
import { loadPricing } from "../src/core/pricing.js";
import { analyze } from "../src/core/engine.js";

const N = Number(process.argv[2] ?? 1_000_000);

// deterministic PRNG
let seed = 0xbe7c4;
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (min: number, max: number) => Math.floor(min + rand() * (max - min + 1));
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

const MODELS = ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5", "gpt-4o", "gpt-4o-mini"];
const START = Date.UTC(2026, 4, 1);

async function main(): Promise<void> {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tt-bench-")), "bench.jsonl");
  console.log(`Generating ${N.toLocaleString()} records → ${file}`);

  const genStart = performance.now();
  const ws = fs.createWriteStream(file);
  for (let i = 0; i < N; i++) {
    const model = pick(MODELS);
    const sessioned = rand() < 0.2;
    const rec = {
      id: `b${i}`,
      timestamp: new Date(START + ri(0, 30 * 86_400_000)).toISOString(),
      provider: model.startsWith("claude") ? "anthropic" : "openai",
      model,
      input_tokens: ri(200, 40_000),
      output_tokens: ri(10, 3_000),
      cache_read_tokens: rand() < 0.2 ? ri(1_000, 20_000) : 0,
      cache_write_tokens: 0,
      status: rand() < 0.02 ? 500 : 200,
      latency_ms: ri(300, 9_000),
      session_id: sessioned ? `s${i % 5_000}` : null,
      system_prompt_hash: rand() < 0.6 ? `h${i % 40}` : null,
      full_prompt_hash: rand() < 0.3 ? `f${i % 50_000}` : `u${i}`,
      max_tokens_set: rand() < 0.8,
      metadata: { service: `svc${i % 8}` },
    };
    if (!ws.write(JSON.stringify(rec) + "\n")) {
      await new Promise<void>((resolve) => ws.once("drain", resolve));
    }
  }
  await new Promise<void>((resolve) => ws.end(resolve));
  const sizeMb = fs.statSync(file).size / 1024 / 1024;
  console.log(`Generated in ${((performance.now() - genStart) / 1000).toFixed(1)}s (${sizeMb.toFixed(0)} MB)\n`);

  const t0 = performance.now();
  const { records, skips } = await ingestPath(file);
  const t1 = performance.now();
  const pricing = loadPricing();
  const result = analyze(records, pricing, skips);
  const t2 = performance.now();

  const heapMb = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`Ingest (streaming): ${((t1 - t0) / 1000).toFixed(2)}s`);
  console.log(`Analyze (sessions + ${result.findings.length} findings): ${((t2 - t1) / 1000).toFixed(2)}s`);
  console.log(`TOTAL: ${((t2 - t0) / 1000).toFixed(2)}s for ${records.length.toLocaleString()} records (heap ${heapMb.toFixed(0)} MB)`);
  console.log(`Spend $${result.totalSpend.toFixed(0)} · waste $${result.addressableWaste.toFixed(0)}`);

  const pass = (t2 - t0) / 1000 < 60;
  console.log(pass ? "\nPASS: under the 60s NFR budget" : "\nFAIL: over the 60s NFR budget");
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  if (!pass) process.exitCode = 1;
}

main();

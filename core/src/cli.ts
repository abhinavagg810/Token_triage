#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { ingestPath, IngestError } from "./ingest/index.js";
import { loadPricing, bundledPricingPath, defaultOverridePath } from "./core/pricing.js";
import { analyze } from "./core/engine.js";
import { renderTerminal } from "./report/terminal.js";
import { renderJson } from "./report/json.js";
import { renderHtml } from "./report/html.js";
import { generateNarrative } from "./report/narrative.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const program = new Command();
program
  .name("tokentriage")
  .description("Explains why your LLM API bill is high — and how to cut it. Fully local; no data leaves your machine.")
  .version("0.1.0");

interface AnalyzeFlags {
  out: string;
  json?: boolean;
  narrate?: boolean;
  sessionInference: boolean;
  period?: string;
  db?: string;
}

async function runAnalyze(inputPath: string, flags: AnalyzeFlags): Promise<void> {
  let periodDays: number | null = null;
  if (flags.period) {
    const m = /^(\d+)\s*d(ays?)?$/i.exec(flags.period.trim());
    if (!m) {
      console.error(`Invalid --period value "${flags.period}". Use e.g. --period 30d`);
      process.exitCode = 1;
      return;
    }
    periodDays = Number(m[1]);
  }

  let ingest;
  try {
    ingest = await ingestPath(inputPath);
  } catch (err) {
    if (err instanceof IngestError) {
      console.error(`${err.code}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const pricing = loadPricing();
  const result = analyze(ingest.records, pricing, ingest.skips, {
    sessionInference: flags.sessionInference,
    periodDays,
  });

  if (flags.db) {
    const { exportDb } = await import("./report/db.js");
    const dbPath = path.resolve(flags.db);
    const counts = await exportDb(result, pricing, dbPath);
    console.error(
      `SQLite export: ${dbPath} (${counts.requests.toLocaleString()} requests, ${counts.sessions.toLocaleString()} sessions, ${counts.findings} findings, ${counts.daily_spend} daily rows)`
    );
  }

  if (flags.json) {
    console.log(renderJson(result));
    return;
  }

  let narrative: string | null = null;
  if (flags.narrate) {
    try {
      console.error("Generating narrative (sending aggregated findings only — never raw logs)...");
      narrative = await generateNarrative(result);
    } catch (err) {
      console.error(`--narrate failed: ${(err as Error).message}`);
      console.error("Continuing without narrative.");
    }
  }

  const outPath = path.resolve(flags.out);
  fs.writeFileSync(outPath, renderHtml(result, narrative), "utf-8");
  console.log(renderTerminal(result, outPath, process.stdout.isTTY ?? false));
}

program
  .command("analyze")
  .description("Analyze a log file or directory (auto-detects format)")
  .argument("<path>", "log file or directory")
  .option("--out <file>", "HTML report output path", "tokentriage-report.html")
  .option("--json", "emit machine-readable findings to stdout instead of HTML")
  .option("--narrate", "embed an LLM-written executive summary (uses TOKENTRIAGE_LLM_KEY; the only network call)")
  .option("--no-session-inference", "disable heuristic session reconstruction")
  .option("--period <window>", "restrict analysis to the most recent window, e.g. 30d")
  .option("--db <path>", "also export records, sessions and findings to a SQLite file (see docs/db-schema.md)")
  .action(async (inputPath: string, flags: AnalyzeFlags) => {
    await runAnalyze(inputPath, flags);
  });

program
  .command("demo")
  .description("Run TokenTriage on the bundled 30-day sample dataset (works offline)")
  .option("--out <file>", "HTML report output path", "tokentriage-report.html")
  .option("--json", "emit machine-readable findings to stdout instead of HTML")
  .option("--db <path>", "also export the sample analysis to a SQLite file")
  .action(async (flags: { out: string; json?: boolean; db?: string }) => {
    const candidates = [
      path.resolve(__dirname, "..", "samples", "sample-logs.jsonl"),
      path.resolve(__dirname, "..", "..", "samples", "sample-logs.jsonl"),
    ];
    const sample = candidates.find((c) => fs.existsSync(c));
    if (!sample) {
      console.error("Bundled sample dataset not found.");
      process.exitCode = 1;
      return;
    }
    await runAnalyze(sample, { out: flags.out, json: flags.json, db: flags.db, sessionInference: true });
  });

program
  .command("serve")
  .description("Serve a local web dashboard over a SQLite export (tokentriage analyze --db). Local only; requires Node 22.5+")
  .option("--db <path>", "SQLite export to serve", "tokentriage.db")
  .option("--port <port>", "port to listen on", "4117")
  .option("--host <host>", "host to bind (keep it local)", "127.0.0.1")
  .action(async (flags: { db: string; port: string; host: string }) => {
    if (!fs.existsSync(flags.db)) {
      console.error(
        `Database not found: ${flags.db}. Export one first: tokentriage analyze <logs> --db ${flags.db} (or tokentriage demo --db ${flags.db})`
      );
      process.exitCode = 1;
      return;
    }
    const { startServer } = await import("./serve/server.js");
    try {
      await startServer({ dbPath: path.resolve(flags.db), port: Number(flags.port), host: flags.host });
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
      return;
    }
    console.log(`TokenTriage dashboard: http://${flags.host}:${flags.port}`);
    console.log("Local only — reads the database read-only; Ctrl-C to stop.");
  });

program
  .command("formats")
  .description("Print supported input formats and the canonical record schema")
  .action(() => {
    console.log(`Supported input formats (auto-detected from the first 50 lines):

  1. Generic JSONL    — the universal path: one canonical record per line (schema below)
  2. Helicone export  — CSV or JSONL request export
  3. Langfuse export  — JSON/JSONL/CSV of generations (traceId maps to session)
  4. OpenAI usage CSV — AGGREGATE ONLY: spend trends + model mix; per-request
                        analyzers (caching, context bloat, retries) are skipped

Canonical record schema (generic JSONL, one object per line):

{
  "id": "string",
  "timestamp": "ISO-8601",
  "provider": "anthropic | openai | other",
  "model": "string",
  "input_tokens": 0,
  "output_tokens": 0,
  "cache_read_tokens": 0,
  "cache_write_tokens": 0,
  "status": 200,
  "latency_ms": 0,
  "session_id": "string | null",
  "system_prompt_hash": "sha256 | null",
  "full_prompt_hash": "sha256 | null",
  "max_tokens_set": true,
  "metadata": {}
}

Required: model, input_tokens, output_tokens, timestamp. Everything else
degrades gracefully (some analyzers need hashes/sessions to fire).

Privacy: if an export contains prompt bodies, TokenTriage hashes them in
memory and never writes them to disk, cache, or report.`);
  });

program
  .command("pricing")
  .description("Print the active pricing table and override path")
  .action(() => {
    const pricing = loadPricing();
    console.log(`Bundled pricing: ${bundledPricingPath()}`);
    console.log(`Override file:   ${defaultOverridePath()} ${pricing.overrideLoaded ? "(loaded)" : "(not present)"}`);
    console.log("");
    const rows: string[][] = [["Provider", "Model", "Input/MTok", "Output/MTok", "Cache read", "Cache write", "Tier", "Verified"]];
    for (const [provider, models] of Object.entries(pricing.models)) {
      for (const [model, p] of Object.entries(models)) {
        rows.push([
          provider,
          model,
          `$${p.input_per_mtok}`,
          `$${p.output_per_mtok}`,
          `$${p.cache_read_per_mtok}`,
          `$${p.cache_write_per_mtok}`,
          p.tier ?? "-",
          p.last_verified ?? "-",
        ]);
      }
    }
    const widths = rows[0]!.map((_, col) => Math.max(...rows.map((r) => r[col]!.length)));
    for (const [i, row] of rows.entries()) {
      console.log(row.map((cell, col) => cell.padEnd(widths[col]!)).join("  "));
      if (i === 0) console.log(widths.map((w) => "-".repeat(w)).join("  "));
    }
    console.log(`\nModel aliases: ${Object.keys(pricing.aliases).length} (date-suffixed names normalize automatically)`);
  });

program.parseAsync(process.argv);

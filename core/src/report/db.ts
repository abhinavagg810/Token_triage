import type { AnalysisResult } from "../core/engine.js";
import type { PricingTable } from "../core/pricing.js";

/**
 * --db: export normalized records, sessions, findings and daily spend to a
 * SQLite file — the integration point for the agent/ service (schema
 * documented in docs/db-schema.md).
 *
 * Uses node:sqlite (Node >= 22.5) so the core CLI keeps zero native runtime
 * dependencies. Privacy holds here too: only hashes and token counts are
 * written, never prompt bodies.
 */
export interface DbCounts {
  requests: number;
  sessions: number;
  findings: number;
  daily_spend: number;
}

export async function exportDb(
  result: AnalysisResult,
  pricing: PricingTable,
  dbPath: string
): Promise<DbCounts> {
  let DatabaseSync: new (path: string) => NodeSqliteDb;
  try {
    ({ DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string) => NodeSqliteDb;
    });
  } catch {
    throw new Error("--db requires Node.js >= 22.5 (uses the built-in node:sqlite module).");
  }

  const fs = await import("node:fs");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); // full re-export, not incremental

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE requests (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        ts INTEGER,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        normalized_model TEXT NOT NULL,
        service TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        status INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        session_id TEXT,
        system_prompt_hash TEXT,
        full_prompt_hash TEXT,
        max_tokens_set INTEGER NOT NULL,
        cost_usd REAL NOT NULL
      );
      CREATE INDEX idx_requests_ts ON requests(ts);
      CREATE INDEX idx_requests_session ON requests(session_id);
      CREATE INDEX idx_requests_sys_hash ON requests(system_prompt_hash);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        inferred INTEGER NOT NULL,
        turns INTEGER NOT NULL,
        first_ts TEXT NOT NULL,
        last_ts TEXT NOT NULL,
        first_input_tokens INTEGER NOT NULL,
        last_input_tokens INTEGER NOT NULL,
        total_cost_usd REAL NOT NULL
      );
      CREATE TABLE findings (
        analyzer_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        wasted_usd REAL NOT NULL,
        pct_of_total REAL NOT NULL,
        confidence TEXT NOT NULL,
        upper_bound INTEGER NOT NULL,
        projected_monthly_savings_usd REAL NOT NULL,
        evidence_json TEXT NOT NULL,
        fix_json TEXT NOT NULL,
        details_json TEXT
      );
      CREATE TABLE daily_spend (
        date TEXT PRIMARY KEY,
        usd REAL NOT NULL,
        requests INTEGER NOT NULL
      );
      -- Populated by the agent service so TokenTriage can audit itself.
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        model TEXT NOT NULL,
        question TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        llm_calls INTEGER NOT NULL DEFAULT 0
      );
    `);

    const requestsByDay = new Map<string, number>();
    db.exec("BEGIN");
    const insReq = db.prepare(
      `INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const r of result.records) {
      const service =
        typeof r.metadata["service"] === "string"
          ? (r.metadata["service"] as string)
          : typeof r.metadata["agent"] === "string"
            ? (r.metadata["agent"] as string)
            : null;
      insReq.run(
        r.id,
        r.timestamp,
        Number.isNaN(r.ts) ? null : r.ts,
        r.provider,
        r.model,
        pricing.normalize(r.model),
        service,
        r.input_tokens,
        r.output_tokens,
        r.cache_read_tokens,
        r.cache_write_tokens,
        r.status,
        r.latency_ms,
        r.session_id,
        r.system_prompt_hash,
        r.full_prompt_hash,
        r.max_tokens_set ? 1 : 0,
        pricing.cost(r)
      );
      const day = r.timestamp.slice(0, 10);
      if (day) requestsByDay.set(day, (requestsByDay.get(day) ?? 0) + (r.n_requests ?? 1));
    }

    const insSess = db.prepare(`INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?,?,?,?)`);
    for (const s of result.sessions) {
      const first = s.records[0]!;
      const last = s.records[s.records.length - 1]!;
      insSess.run(
        s.id,
        s.inferred ? 1 : 0,
        s.records.length,
        first.timestamp,
        last.timestamp,
        first.input_tokens,
        last.input_tokens,
        s.records.reduce((acc, r) => acc + pricing.cost(r), 0)
      );
    }

    const insFinding = db.prepare(`INSERT INTO findings VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const f of result.findings) {
      insFinding.run(
        f.analyzer_id,
        f.analyzer_name,
        f.wasted_usd,
        f.pct_of_total,
        f.confidence,
        f.upper_bound ? 1 : 0,
        f.projected_monthly_savings_usd,
        JSON.stringify(f.evidence),
        JSON.stringify(f.fix),
        f.details ? JSON.stringify(f.details) : null
      );
    }

    const insDay = db.prepare(`INSERT INTO daily_spend VALUES (?,?,?)`);
    for (const d of result.dailySpend) {
      insDay.run(d.date, d.usd, requestsByDay.get(d.date) ?? 0);
    }

    const insMeta = db.prepare(`INSERT INTO meta VALUES (?,?)`);
    const meta: Record<string, string> = {
      schema_version: "1",
      generated_at: new Date().toISOString(),
      period_start: result.periodStart,
      period_end: result.periodEnd,
      days_in_dataset: String(result.daysInDataset),
      total_spend_usd: result.totalSpend.toFixed(4),
      addressable_waste_usd: result.addressableWaste.toFixed(4),
      request_count: String(result.requestCount),
    };
    for (const [k, v] of Object.entries(meta)) insMeta.run(k, v);
    db.exec("COMMIT");

    return {
      requests: result.records.length,
      sessions: result.sessions.length,
      findings: result.findings.length,
      daily_spend: result.dailySpend.length,
    };
  } finally {
    db.close();
  }
}

/** Minimal structural type for node:sqlite's DatabaseSync (typed loosely to keep @types/node optional). */
interface NodeSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
}

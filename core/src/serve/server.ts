import http from "node:http";
import fs from "node:fs";
import { renderDashboard } from "./dashboard.js";

/**
 * Phase 2 — `tokentriage serve`: a LOCAL web dashboard over the SQLite export
 * (`tokentriage analyze --db`). Same trust properties as the rest of the tool:
 * binds to 127.0.0.1 by default, read-only database access, zero external
 * dependencies (node:http + node:sqlite), and nothing in the database can
 * contain prompt bodies in the first place.
 *
 * The database is opened PER REQUEST and closed immediately after. That keeps
 * the file unlocked between requests, which matters on Windows: re-exports
 * (`analyze --db`, watch mode) replace the file with an atomic rename, and
 * Windows refuses to rename over a file another process holds open. Opening a
 * small SQLite file is sub-millisecond — negligible for a local dashboard.
 */
export interface ServeOptions {
  dbPath: string;
  port: number;
  host: string;
  /** When launched by `watch`, describes the live capture proxy for the Connect panel. */
  connect?: ConnectInfo;
}

export interface ConnectInfo {
  /** "watch" shows live-capture wiring; "serve" shows a static-snapshot note. */
  mode: "watch" | "serve";
  host?: string;
  proxyPort?: number;
}

interface NodeSqliteDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

const MAX_PAGE_SIZE = 200;

export async function startServer(options: ServeOptions): Promise<http.Server> {
  let DatabaseSync: new (path: string, opts: { readOnly: boolean }) => NodeSqliteDb;
  try {
    ({ DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string, opts: { readOnly: boolean }) => NodeSqliteDb;
    });
  } catch {
    throw new Error("`tokentriage serve` requires Node.js >= 22.5 (uses the built-in node:sqlite module).");
  }

  const openDb = (): NodeSqliteDb => new DatabaseSync(options.dbPath, { readOnly: true });

  // Fail fast on a non-TokenTriage database (open, check, close).
  {
    if (!fs.existsSync(options.dbPath)) {
      throw new Error(
        `Database not found: ${options.dbPath}. Create one with: tokentriage analyze <logs> --db ${options.dbPath}`
      );
    }
    const db = openDb();
    try {
      const schema = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
        | { value: string }
        | undefined;
      if (!schema || schema.value !== "1") {
        throw new Error(
          `${options.dbPath} is not a TokenTriage export (expected meta.schema_version = 1). Create one with: tokentriage analyze <logs> --db ${options.dbPath}`
        );
      }
    } finally {
      db.close();
    }
  }

  /** Build a WHERE clause from optional date/model/service filters — params only, never interpolation. */
  function filters(query: URLSearchParams, dateColumn: string): { where: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const start = query.get("start");
    const end = query.get("end");
    const model = query.get("model");
    const service = query.get("service");
    if (start) {
      clauses.push(`${dateColumn} >= ?`);
      params.push(start);
    }
    if (end) {
      clauses.push(`${dateColumn} <= ?`);
      params.push(end);
    }
    if (model) {
      clauses.push("normalized_model = ?");
      params.push(model);
    }
    if (service) {
      if (service === "(none)") clauses.push("service IS NULL");
      else {
        clauses.push("service = ?");
        params.push(service);
      }
    }
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  const day = "substr(timestamp,1,10)";

  const routes: Record<string, (db: NodeSqliteDb, query: URLSearchParams) => unknown> = {
    "/api/meta": (db) => {
      const meta = Object.fromEntries(
        (db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map(
          (r) => [r.key, r.value]
        )
      );
      const counts = db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM requests) AS requests,
                  (SELECT COUNT(*) FROM sessions) AS sessions,
                  (SELECT COUNT(*) FROM findings) AS findings,
                  (SELECT COUNT(*) FROM agent_runs) AS agent_runs`
        )
        .get();
      return { meta, counts };
    },

    "/api/findings": (db) => {
      const rows = db
        .prepare(
          `SELECT analyzer_id, name, wasted_usd, pct_of_total, confidence, upper_bound,
                  projected_monthly_savings_usd, evidence_json, fix_json, details_json
           FROM findings ORDER BY wasted_usd DESC`
        )
        .all() as Record<string, unknown>[];
      return rows.map((r) => ({
        ...r,
        evidence: JSON.parse(String(r.evidence_json)),
        fix: JSON.parse(String(r.fix_json)),
        details: r.details_json ? JSON.parse(String(r.details_json)) : null,
        evidence_json: undefined,
        fix_json: undefined,
        details_json: undefined,
      }));
    },

    "/api/daily": (db, query) => {
      const { where, params } = filters(query, "date");
      return db
        .prepare(`SELECT date, usd, requests FROM daily_spend ${where} ORDER BY date`)
        .all(...params);
    },

    "/api/models": (db, query) => {
      const { where, params } = filters(query, day);
      return db
        .prepare(
          `SELECT normalized_model AS model, ROUND(SUM(cost_usd),4) AS usd, COUNT(*) AS requests,
                  SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                  SUM(cache_read_tokens) AS cache_read_tokens
           FROM requests ${where} GROUP BY normalized_model ORDER BY usd DESC`
        )
        .all(...params);
    },

    "/api/services": (db, query) => {
      const { where, params } = filters(query, day);
      return db
        .prepare(
          `SELECT COALESCE(service,'(none)') AS service, ROUND(SUM(cost_usd),4) AS usd,
                  COUNT(*) AS requests, SUM(input_tokens) AS input_tokens,
                  SUM(output_tokens) AS output_tokens
           FROM requests ${where} GROUP BY COALESCE(service,'(none)') ORDER BY usd DESC`
        )
        .all(...params);
    },

    "/api/sessions": (db, query) => {
      const limit = Math.min(Number(query.get("limit") ?? 25) || 25, MAX_PAGE_SIZE);
      const order =
        {
          cost: "total_cost_usd DESC",
          growth: "CAST(last_input_tokens AS REAL)/MAX(first_input_tokens,1) DESC",
          turns: "turns DESC",
        }[query.get("metric") ?? "cost"] ?? "total_cost_usd DESC";
      return db
        .prepare(
          `SELECT id, inferred, turns, first_ts, last_ts, first_input_tokens, last_input_tokens,
                  ROUND(total_cost_usd,4) AS total_cost_usd
           FROM sessions ORDER BY ${order} LIMIT ?`
        )
        .all(limit);
    },

    "/api/requests": (db, query) => {
      const { where, params } = filters(query, day);
      const limit = Math.min(Number(query.get("limit") ?? 50) || 50, MAX_PAGE_SIZE);
      const offset = Math.max(Number(query.get("offset") ?? 0) || 0, 0);
      const total = db
        .prepare(`SELECT COUNT(*) AS n FROM requests ${where}`)
        .get(...params) as { n: number };
      const rows = db
        .prepare(
          `SELECT id, timestamp, normalized_model AS model, service, input_tokens, output_tokens,
                  cache_read_tokens, status, latency_ms, session_id, ROUND(cost_usd,6) AS cost_usd
           FROM requests ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
        )
        .all(...params, limit, offset);
      return { total: total.n, offset, limit, rows };
    },

    "/api/agent_runs": (db) => {
      return db
        .prepare(
          `SELECT id, started_at, kind, model, question, input_tokens, output_tokens,
                  cache_read_tokens, llm_calls
           FROM agent_runs ORDER BY started_at DESC LIMIT 100`
        )
        .all();
    },
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderDashboard(options.connect ?? { mode: "serve" }));
        return;
      }
      const handler = routes[url.pathname];
      if (!handler) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      // Open per request, close immediately — keeps the file unlocked so
      // re-exports can swap it (required on Windows).
      const db = openDb();
      let payload: unknown;
      try {
        payload = handler(db, url.searchParams);
      } finally {
        db.close();
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  return server;
}

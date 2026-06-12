import type http from "node:http";
import fs from "node:fs";
import { startProxy } from "../proxy/proxy.js";
import { startServer } from "../serve/server.js";
import { ingestPath } from "../ingest/index.js";
import { loadPricing } from "../core/pricing.js";
import { analyze } from "../core/engine.js";
import { exportDb } from "../report/db.js";
import type { SkipStats } from "../core/schema.js";

/**
 * `tokentriage watch` — the one-command mode: capture proxy + dashboard +
 * automatic re-analysis in a single process. Connect your SDK
 * (ANTHROPIC_BASE_URL / OPENAI_BASE_URL → the proxy) and the dashboard's
 * findings and suggestions stay current on their own.
 *
 * Flow per cycle: new captures mark the state dirty → on the next tick the
 * capture JSONL is re-analyzed → the SQLite export is atomically swapped →
 * the dashboard server hot-reloads it → the dashboard page auto-refreshes.
 */
export interface WatchOptions {
  host: string;
  proxyPort: number;
  dashboardPort: number;
  captureFile: string;
  dbPath: string;
  intervalMs: number;
  anthropicUpstream?: string;
  openaiUpstream?: string;
  /** Called after each re-analysis with a one-line summary (logging hook). */
  onAnalyzed?: (summary: string) => void;
  /** Called when a re-analysis cycle fails (it will retry next tick). */
  onError?: (message: string) => void;
}

export interface WatchHandle {
  proxy: http.Server;
  dashboard: http.Server;
  stop(): Promise<void>;
}

const emptySkips = (): SkipStats => ({ total: 0, skipped: 0, missingFields: new Map() });

export async function startWatch(options: WatchOptions): Promise<WatchHandle> {
  const pricing = loadPricing();

  // Seed an empty export so the dashboard has something to serve before the
  // first request flows through the proxy ("waiting for traffic" state).
  if (!fs.existsSync(options.dbPath)) {
    await exportDb(analyze([], pricing, emptySkips()), pricing, options.dbPath);
  }

  let dirty = false;
  let analyzing = false;

  const proxy = await startProxy({
    port: options.proxyPort,
    host: options.host,
    outPath: options.captureFile,
    anthropicUpstream: options.anthropicUpstream,
    openaiUpstream: options.openaiUpstream,
    onCapture: () => {
      dirty = true;
    },
  });

  const dashboard = await startServer({
    dbPath: options.dbPath,
    port: options.dashboardPort,
    host: options.host,
  });

  async function reanalyze(): Promise<void> {
    if (!dirty || analyzing) return;
    dirty = false;
    analyzing = true;
    try {
      // loadPricing fresh each cycle so override-file edits apply live.
      const livePricing = loadPricing();
      const { records, skips } = await ingestPath(options.captureFile);
      const result = analyze(records, livePricing, skips);
      await exportDb(result, livePricing, options.dbPath);
      const top = result.findings[0];
      options.onAnalyzed?.(
        `${result.requestCount.toLocaleString()} requests · spend $${result.totalSpend.toFixed(2)} · ` +
          `waste $${result.addressableWaste.toFixed(2)}` +
          (top ? ` · top: ${top.analyzer_name} ($${top.wasted_usd.toFixed(2)})` : "")
      );
    } catch (err) {
      // capture file may be empty or mid-write — report and try again next tick
      options.onError?.((err as Error).message);
      dirty = true;
    } finally {
      analyzing = false;
    }
  }

  const timer = setInterval(() => {
    void reanalyze();
  }, options.intervalMs);
  timer.unref?.();

  return {
    proxy,
    dashboard,
    async stop(): Promise<void> {
      clearInterval(timer);
      await Promise.all([
        new Promise<void>((r) => proxy.close(() => r())),
        new Promise<void>((r) => dashboard.close(() => r())),
      ]);
    },
  };
}

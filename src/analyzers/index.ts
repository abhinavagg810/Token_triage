import type { Analyzer } from "./types.js";
import { retryWaste } from "./retry-waste.js";
import { cacheMiss } from "./cache-miss.js";
import { contextBloat } from "./context-bloat.js";
import { modelOverkill } from "./model-overkill.js";
import { verboseOutput } from "./verbose-output.js";

/**
 * Run order IS the claimed-token ledger priority (PRD §5.5):
 * A4 retry → A1 cache-miss → A2 context-bloat → A3 overkill → A5 verbose.
 * Waste from a retried call must not also count as a cache miss, etc.
 */
export const ANALYZERS: Analyzer[] = [retryWaste, cacheMiss, contextBloat, modelOverkill, verboseOutput];

/** Analyzers that need per-request records and timestamps/sessions. */
export const SESSION_DEPENDENT = new Set(["retry-waste", "context-bloat"]);

export * from "./types.js";

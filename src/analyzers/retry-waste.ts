import type { Analyzer, AnalyzerContext, Finding } from "./types.js";
import { projectMonthly } from "./types.js";

const DUPLICATE_WINDOW_MS = 60_000; // identical full_prompt_hash within 60s

/**
 * A4 — Retry / duplicate waste.
 * (a) full_prompt_hash repeats within 60s → duplicate fire
 * (b) status >= 400 followed by an identical hash → retry after failure
 * Waste = full cost of all-but-first occurrence. Highest ledger priority:
 * a retried call's tokens must not also count as a cache miss.
 */
export const retryWaste: Analyzer = {
  id: "retry-waste",
  name: "Retry/duplicate calls",
  detect(ctx: AnalyzerContext): Finding | null {
    const withHash = ctx.records
      .filter((r) => r.full_prompt_hash && !Number.isNaN(r.ts) && !r.aggregate)
      .sort((a, b) => a.ts - b.ts);
    if (withHash.length === 0) return null;

    let wasted = 0;
    let duplicateCalls = 0;
    let retryAfterErrorCalls = 0;
    const lastSeen = new Map<string, { ts: number; status: number }>();
    const dayWaste = new Map<string, number>();

    for (const r of withHash) {
      const hash = r.full_prompt_hash!;
      const prev = lastSeen.get(hash);
      const isDuplicate = prev !== undefined && r.ts - prev.ts <= DUPLICATE_WINDOW_MS;
      const isRetryAfterError = prev !== undefined && prev.status >= 400;

      if (isDuplicate || isRetryAfterError) {
        const claimed = ctx.ledger.claimAll(r);
        const price = ctx.pricing.lookup(r.provider, r.model);
        if (price) {
          wasted +=
            (claimed.input * price.input_per_mtok + claimed.output * price.output_per_mtok) /
            1_000_000;
        }
        if (isDuplicate && !isRetryAfterError) duplicateCalls++;
        else retryAfterErrorCalls++;
        const day = r.timestamp.slice(0, 10);
        dayWaste.set(day, (dayWaste.get(day) ?? 0) + 1);
      }
      lastSeen.set(hash, { ts: r.ts, status: r.status });
    }

    if (wasted < 0.01 || duplicateCalls + retryAfterErrorCalls === 0) return null;

    const worstDay = [...dayWaste.entries()].sort((a, b) => b[1] - a[1])[0];
    const evidence = [
      {
        label: "Duplicate fires",
        detail: `${duplicateCalls.toLocaleString()} calls repeated an identical prompt within 60s of the previous send`,
      },
      {
        label: "Retries after errors",
        detail: `${retryAfterErrorCalls.toLocaleString()} calls re-sent an identical prompt after a 4xx/5xx response`,
      },
    ];
    if (worstDay) {
      evidence.push({
        label: "Hotspot",
        detail: `${worstDay[1].toLocaleString()} wasted calls on ${worstDay[0]} — check deploys/incidents on that day`,
      });
    }

    return {
      analyzer_id: "retry-waste",
      analyzer_name: "Retry/duplicate calls",
      wasted_usd: wasted,
      pct_of_total: ctx.totalSpend > 0 ? wasted / ctx.totalSpend : 0,
      confidence: "high",
      evidence,
      fix: {
        summary:
          "Deduplicate identical in-flight requests with a short-lived response cache, and use exponential backoff for retries.",
        steps: [
          "Hash the request payload and cache responses for ~60s to absorb duplicate fires.",
          "Wrap provider calls in exponential backoff (e.g. tenacity / p-retry) instead of immediate re-sends.",
          "On retry after a context-length or validation error, trim the payload rather than re-sending it verbatim.",
        ],
        snippet: `@retry(wait=wait_exponential(min=1, max=30), stop=stop_after_attempt(4))
def call_llm(payload):
    # cache identical payload hashes for 60s to kill duplicate fires
    key = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    if cached := response_cache.get(key):
        return cached
    response = client.messages.create(**payload)
    response_cache.set(key, response, ttl=60)
    return response`,
        snippet_lang: "python",
      },
      projected_monthly_savings_usd: projectMonthly(wasted, ctx.daysInDataset),
    };
  },
};

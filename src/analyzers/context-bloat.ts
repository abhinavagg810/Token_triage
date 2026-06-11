import type { Analyzer, AnalyzerContext, Finding } from "./types.js";
import { projectMonthly } from "./types.js";

const MIN_TURNS = 5; // session length >= 5 turns
const GROWTH_RATIO = 3; // final/first input ratio > 3x

/**
 * A2 — Context bloat: agent/chat sessions that resend the full history every
 * turn, so input_tokens balloons over the conversation.
 * Detection: within a session, input grows (final/first > 3×) and length >= 5.
 * Waste: tokens above a baseline of (first-turn input + 2× median
 * new-content-per-turn), i.e. what a sliding-window/summarization strategy
 * would plausibly have sent instead.
 */
export const contextBloat: Analyzer = {
  id: "context-bloat",
  name: "Context bloat (agents)",
  detect(ctx: AnalyzerContext): Finding | null {
    interface SessionResult {
      id: string;
      turns: number;
      firstInput: number;
      lastInput: number;
      wasted: number;
      inputs: number[];
    }
    const results: SessionResult[] = [];
    let totalWasted = 0;
    let totalSessions = 0;

    for (const session of ctx.sessions) {
      const recs = session.records;
      if (recs.length < MIN_TURNS) continue;
      const first = recs[0]!;
      const last = recs[recs.length - 1]!;
      if (first.input_tokens <= 0) continue;
      if (last.input_tokens / first.input_tokens <= GROWTH_RATIO) continue;

      // Median per-turn growth = the "new content" each turn actually adds.
      const deltas: number[] = [];
      for (let i = 1; i < recs.length; i++) {
        deltas.push(Math.max(0, recs[i]!.input_tokens - recs[i - 1]!.input_tokens));
      }
      const medianDelta = median(deltas);
      const baseline = first.input_tokens + 2 * medianDelta;

      let sessionWasted = 0;
      for (const r of recs) {
        const excess = r.input_tokens - baseline;
        if (excess <= 0) continue;
        const claimed = ctx.ledger.claimInput(r, excess);
        const price = ctx.pricing.lookup(r.provider, r.model);
        if (price) sessionWasted += (claimed * price.input_per_mtok) / 1_000_000;
      }
      if (sessionWasted < 0.005) continue;

      totalWasted += sessionWasted;
      totalSessions++;
      results.push({
        id: session.id,
        turns: recs.length,
        firstInput: first.input_tokens,
        lastInput: last.input_tokens,
        wasted: sessionWasted,
        inputs: recs.map((r) => r.input_tokens),
      });
    }

    if (totalWasted < 0.01) return null;
    results.sort((a, b) => b.wasted - a.wasted);
    const worst = results.slice(0, 5);

    return {
      analyzer_id: "context-bloat",
      analyzer_name: "Context bloat (agents)",
      wasted_usd: totalWasted,
      pct_of_total: ctx.totalSpend > 0 ? totalWasted / ctx.totalSpend : 0,
      confidence: "high",
      evidence: [
        {
          label: "Bloated sessions",
          detail: `${totalSessions.toLocaleString()} sessions grew >${GROWTH_RATIO}× from first to last turn (avg ${avg(results.map((r) => r.turns)).toFixed(1)} turns)`,
        },
        ...worst.slice(0, 2).map((s) => ({
          label: `Session ${s.id}`,
          detail: `${s.turns} turns, input ${s.firstInput.toLocaleString()} → ${s.lastInput.toLocaleString()} tokens · $${s.wasted.toFixed(2)} wasted`,
        })),
      ],
      fix: {
        summary:
          "Cap resent history with a sliding window, summarizing older turns instead of resending them verbatim.",
        steps: [
          "Keep only the last K turns verbatim (K=8 is a good start for most agents).",
          "Replace older turns with a single summary message, regenerated as the window slides.",
          "For tool-heavy agents, drop or truncate stale tool results — they dominate the growth.",
        ],
        snippet: `MAX_HISTORY_TURNS = 8

def build_messages(history, new_msg):
    recent = history[-MAX_HISTORY_TURNS:]
    if len(history) > MAX_HISTORY_TURNS:
        recent = [summary_message(history[:-MAX_HISTORY_TURNS])] + recent
    return recent + [new_msg]`,
        snippet_lang: "python",
      },
      projected_monthly_savings_usd: projectMonthly(totalWasted, ctx.daysInDataset),
      details: {
        worst_sessions: worst.map((s) => ({
          id: s.id,
          turns: s.turns,
          first_input: s.firstInput,
          last_input: s.lastInput,
          wasted_usd: round2(s.wasted),
          growth: s.inputs,
        })),
      },
    };
  },
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function avg(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

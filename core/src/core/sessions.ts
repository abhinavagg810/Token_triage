import type { CanonicalRecord, Session } from "./schema.js";

const MAX_SESSION_GAP_MS = 30 * 60 * 1000; // 30 minutes (PRD §5.3)

/**
 * Session reconstruction (PRD §5.3).
 *
 * - Records with an explicit session_id are grouped by it.
 * - Otherwise (unless inference is disabled), heuristic grouping: same
 *   system_prompt_hash + non-decreasing input_tokens + inter-call gap < 30 min.
 *
 * Known edge case (disclosed in the report footnotes): parallel sessions with
 * identical system prompts may merge incorrectly.
 */
export function reconstructSessions(
  records: CanonicalRecord[],
  options: { inference?: boolean } = {}
): Session[] {
  const inference = options.inference ?? true;
  const sorted = [...records].sort((a, b) => a.ts - b.ts);

  const explicit = new Map<string, CanonicalRecord[]>();
  const orphans: CanonicalRecord[] = [];
  for (const r of sorted) {
    if (r.session_id) {
      const list = explicit.get(r.session_id) ?? [];
      list.push(r);
      explicit.set(r.session_id, list);
    } else {
      orphans.push(r);
    }
  }

  const sessions: Session[] = [];
  for (const [id, recs] of explicit) {
    sessions.push({ id, records: recs, inferred: false });
  }

  if (inference) {
    // Group orphans by system prompt hash, then split on time gaps and
    // input-token monotonicity breaks.
    const byHash = new Map<string, CanonicalRecord[]>();
    for (const r of orphans) {
      if (!r.system_prompt_hash || Number.isNaN(r.ts)) continue;
      const list = byHash.get(r.system_prompt_hash) ?? [];
      list.push(r);
      byHash.set(r.system_prompt_hash, list);
    }
    let counter = 0;
    for (const recs of byHash.values()) {
      let current: CanonicalRecord[] = [];
      const flush = () => {
        if (current.length >= 2) {
          sessions.push({ id: `inferred_${counter++}`, records: current, inferred: true });
        }
        current = [];
      };
      for (const r of recs) {
        const prev = current[current.length - 1];
        if (
          prev &&
          r.ts - prev.ts < MAX_SESSION_GAP_MS &&
          r.input_tokens >= prev.input_tokens
        ) {
          current.push(r);
        } else {
          flush();
          current = [r];
        }
      }
      flush();
    }
  }

  return sessions;
}

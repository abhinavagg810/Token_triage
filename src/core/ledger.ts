import type { CanonicalRecord } from "./schema.js";

/**
 * Claimed-token ledger — the double-counting guard (PRD §5.5).
 *
 * A token can be claimed by only one analyzer. Analyzers run in priority
 * order (A4 retry → A1 cache-miss → A2 context-bloat → A3 overkill →
 * A5 verbose) and must claim the tokens their waste figure is based on;
 * later analyzers only see what's left.
 */
export class TokenLedger {
  private claimedInput = new Map<string, number>();
  private claimedOutput = new Map<string, number>();

  availableInput(record: CanonicalRecord): number {
    return Math.max(0, record.input_tokens - (this.claimedInput.get(record.id) ?? 0));
  }

  availableOutput(record: CanonicalRecord): number {
    return Math.max(0, record.output_tokens - (this.claimedOutput.get(record.id) ?? 0));
  }

  /** Claim up to `tokens` input tokens; returns how many were actually claimed. */
  claimInput(record: CanonicalRecord, tokens: number): number {
    const granted = Math.min(Math.max(0, tokens), this.availableInput(record));
    this.claimedInput.set(record.id, (this.claimedInput.get(record.id) ?? 0) + granted);
    return granted;
  }

  /** Claim up to `tokens` output tokens; returns how many were actually claimed. */
  claimOutput(record: CanonicalRecord, tokens: number): number {
    const granted = Math.min(Math.max(0, tokens), this.availableOutput(record));
    this.claimedOutput.set(record.id, (this.claimedOutput.get(record.id) ?? 0) + granted);
    return granted;
  }

  /** Claim everything on a record (used by retry-waste for duplicate calls). */
  claimAll(record: CanonicalRecord): { input: number; output: number } {
    return {
      input: this.claimInput(record, record.input_tokens),
      output: this.claimOutput(record, record.output_tokens),
    };
  }
}

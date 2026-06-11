import { describe, it, expect } from "vitest";
import { TokenLedger } from "../src/core/ledger.js";
import { rec } from "./helpers.js";

describe("TokenLedger (double-counting guard)", () => {
  it("caps claims at the record's token count", () => {
    const ledger = new TokenLedger();
    const r = rec({ input_tokens: 1000 });
    expect(ledger.claimInput(r, 1500)).toBe(1000);
    expect(ledger.availableInput(r)).toBe(0);
  });

  it("a token can be claimed by only one analyzer", () => {
    const ledger = new TokenLedger();
    const r = rec({ input_tokens: 1000 });
    expect(ledger.claimInput(r, 600)).toBe(600);
    expect(ledger.claimInput(r, 600)).toBe(400); // only what's left
    expect(ledger.claimInput(r, 100)).toBe(0);
  });

  it("tracks input and output independently", () => {
    const ledger = new TokenLedger();
    const r = rec({ input_tokens: 1000, output_tokens: 200 });
    ledger.claimAll(r);
    expect(ledger.availableInput(r)).toBe(0);
    expect(ledger.availableOutput(r)).toBe(0);
  });
});

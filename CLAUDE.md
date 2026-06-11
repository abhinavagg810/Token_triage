# TokenTriage — working notes for Claude Code

The product spec lives in **PRD.md** at the repo root — read it before changing behavior.
Error/warning copy (E-101, E-102, W-201…W-203), analyzer formulas, and the CLI surface
are specified there exactly; don't drift from them.

## Architecture

```
src/cli.ts          commander CLI (analyze | demo | formats | pricing)
src/ingest/         format detection + adapters → canonical schema (src/core/schema.ts)
src/core/           pricing table, session reconstruction, claimed-token ledger, engine
src/analyzers/      one module per analyzer; index.ts array order == ledger priority
src/report/         terminal table, --json, single-file HTML, optional --narrate
scripts/            sample dataset generator (deterministic, seeded)
```

## Invariants

- **Privacy:** prompt bodies are hashed in memory only — never written to disk, cache, or report.
- **No network calls** except opt-in `--narrate` (aggregated findings only).
- **Ledger:** a token is claimed by exactly one analyzer; run order A4 → A1 → A2 → A3 → A5.
- **Conservative math:** "up to" labels for heuristics, documented thresholds in
  `src/analyzers/THRESHOLDS.md`.
- The bundled sample must keep all five analyzers firing near the PRD §12.5 table
  (asserted in `test/engine.test.ts`). After touching analyzers or the generator, run
  `npm run generate-sample && npm run dev -- demo` and check the table.

## Commands

```bash
npm test                  # vitest
npm run dev -- demo       # end-to-end smoke test
npm run build             # tsc → dist (bin: dist/cli.js)
```

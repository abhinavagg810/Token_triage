# Contributing to TokenTriage

Thanks for helping make LLM bills explainable. The two friendliest contribution surfaces:

## 1. Pricing updates (`pricing.json`)

Provider pricing changes often and wrong math destroys credibility. To update or add a model:

1. Edit `pricing.json` — per-MTok USD figures for `input`, `output`, `cache_read`, `cache_write`.
2. Set `tier` (`frontier` | `mid` | `budget`) — the model-overkill analyzer uses this to pick a cheaper same-provider route.
3. Set `last_verified` to today's date and link the provider pricing page in your PR description.
4. Add date-suffixed model IDs (e.g. `gpt-4o-2024-11-20`) to the `aliases` map.

## 2. New analyzers

Each analyzer is one module in `src/analyzers/` exporting the `Analyzer` interface:

```ts
export const myAnalyzer: Analyzer = {
  id: "my-analyzer",
  name: "Human-readable cause",
  detect(ctx: AnalyzerContext): Finding | null { ... }
};
```

Rules of the house:

- **Claim your tokens.** Use `ctx.ledger.claimInput/claimOutput` for every token your waste figure is based on; respect what's already claimed. Register the analyzer in `src/analyzers/index.ts` — array order is ledger priority.
- **Ship a fix.** Every finding needs a `fix` with steps and ideally a copy-paste snippet. Findings without fixes are just complaints.
- **Be conservative.** Use "up to" (`upper_bound: true`) when detection is heuristic; pick the lower-bound formula when in doubt.
- **Document thresholds** in `src/analyzers/THRESHOLDS.md`.
- **Test both directions.** Add fixture tests in `test/` proving it fires on the bad pattern and stays quiet on healthy traffic. If the pattern is common, bake it into `scripts/generate-sample.ts` too.

## 3. Ingest adapters

Adapters in `src/ingest/` map vendor exports to the canonical schema (`src/core/schema.ts`).
Hard rule: **prompt/response bodies are hashed in memory and never persisted** — no exceptions.
The generic JSONL format is the canonical path; adapters are convenience and may lag vendor changes.

## Dev loop

```bash
npm install
npm test
npm run dev -- demo            # full pipeline on the sample dataset
npm run generate-sample        # regenerate the sample after changing the generator
```

TypeScript strict mode; no runtime dependencies beyond `commander`. Keep the HTML report dependency-free (inline CSS/JS, hand-rolled SVG).

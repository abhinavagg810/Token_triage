import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { CanonicalRecord } from "./schema.js";

export interface ModelPrice {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
  tier?: "frontier" | "mid" | "budget";
  supports_caching?: boolean;
  /** Priced for historical logs but excluded from routing recommendations. */
  retired?: boolean;
  last_verified?: string;
}

export interface PricingFile {
  models: Record<string, Record<string, ModelPrice>>;
  aliases: Record<string, string>;
}

export class PricingTable {
  readonly models: Record<string, Record<string, ModelPrice>>;
  readonly aliases: Record<string, string>;
  readonly overridePath: string;
  readonly overrideLoaded: boolean;
  /** Models seen in data with no pricing entry (costed at $0). */
  readonly unpriced = new Set<string>();

  constructor(base: PricingFile, override?: Partial<PricingFile>, overridePath = "") {
    this.models = JSON.parse(JSON.stringify(base.models));
    this.aliases = { ...base.aliases };
    this.overridePath = overridePath;
    this.overrideLoaded = !!override;
    if (override?.models) {
      for (const [provider, models] of Object.entries(override.models)) {
        this.models[provider] = { ...(this.models[provider] ?? {}), ...models };
      }
    }
    if (override?.aliases) Object.assign(this.aliases, override.aliases);
  }

  /** Normalize a raw model name: alias map first, then strip date suffixes. */
  normalize(model: string): string {
    const direct = this.aliases[model];
    if (direct) return direct;
    const stripped = model
      .replace(/-\d{4}-\d{2}-\d{2}$/, "")
      .replace(/-\d{8}$/, "")
      .replace(/-(latest|preview)$/, "");
    return this.aliases[stripped] ?? stripped;
  }

  lookup(provider: string, model: string): ModelPrice | null {
    const normalized = this.normalize(model);
    const byProvider = this.models[provider]?.[normalized];
    if (byProvider) return byProvider;
    // Provider field may be wrong/missing in some exports; search all providers.
    for (const models of Object.values(this.models)) {
      if (models[normalized]) return models[normalized];
    }
    this.unpriced.add(model);
    return null;
  }

  /** Cost of a record in USD. Unknown models cost $0 and are tracked in `unpriced`. */
  cost(record: CanonicalRecord): number {
    const p = this.lookup(record.provider, record.model);
    if (!p) return 0;
    return (
      (record.input_tokens * p.input_per_mtok +
        record.output_tokens * p.output_per_mtok +
        record.cache_read_tokens * p.cache_read_per_mtok +
        record.cache_write_tokens * p.cache_write_per_mtok) /
      1_000_000
    );
  }

  /**
   * Cheapest budget-tier model from the same provider (for model-overkill
   * routing). Retired models stay priceable for historical logs but are
   * never recommended as a route.
   */
  cheapestBudget(provider: string): { model: string; price: ModelPrice } | null {
    const models = this.models[provider];
    if (!models) return null;
    let best: { model: string; price: ModelPrice } | null = null;
    for (const [model, price] of Object.entries(models)) {
      if (price.tier !== "budget" || price.retired) continue;
      if (!best || price.input_per_mtok < best.price.input_per_mtok) {
        best = { model, price };
      }
    }
    return best;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function defaultOverridePath(): string {
  return path.join(os.homedir(), ".tokentriage", "pricing.override.json");
}

/** Locate the bundled pricing.json (repo root / package root). */
export function bundledPricingPath(): string {
  for (const candidate of [
    path.resolve(__dirname, "..", "..", "pricing.json"), // dist/core -> package root
    path.resolve(__dirname, "..", "..", "..", "pricing.json"), // src/core via tsx
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Bundled pricing.json not found");
}

export function loadPricing(overridePath = defaultOverridePath()): PricingTable {
  const base = JSON.parse(fs.readFileSync(bundledPricingPath(), "utf-8")) as PricingFile;
  let override: Partial<PricingFile> | undefined;
  if (fs.existsSync(overridePath)) {
    override = JSON.parse(fs.readFileSync(overridePath, "utf-8")) as Partial<PricingFile>;
  }
  return new PricingTable(base, override, overridePath);
}

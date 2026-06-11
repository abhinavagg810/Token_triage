import type { AnalysisResult } from "../core/engine.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function confColor(c: string): string {
  return c === "high" ? GREEN : c === "medium" ? YELLOW : DIM;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtDate(iso: string): string {
  if (iso === "unknown") return "unknown";
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: undefined, timeZone: "UTC" });
}

export function renderTerminal(result: AnalysisResult, reportPath: string | null, color = true): string {
  const c = (code: string, text: string) => (color ? `${code}${text}${RESET}` : text);
  const lines: string[] = [];

  const period = `${fmtDate(result.periodStart)} – ${fmtDate(result.periodEnd)} ${new Date(result.periodEnd + "T00:00:00Z").getUTCFullYear() || ""}`.trim();
  lines.push(
    c(BOLD, "TokenTriage") +
      ` — analyzed ${result.requestCount.toLocaleString()} requests · ${period} (${result.daysInDataset} day${result.daysInDataset === 1 ? "" : "s"})`
  );

  if (result.smallSample) {
    lines.push(c(YELLOW, `⚠ Small sample (N=${result.requestCount}). Findings are directional, not conclusive.`));
  }

  const wastePct = result.totalSpend > 0 ? (result.addressableWaste / result.totalSpend) * 100 : 0;
  lines.push(
    `Total spend: ${c(BOLD, usd(result.totalSpend))}        Addressable waste found: ${c(
      BOLD + (wastePct > 25 ? RED : YELLOW),
      `${usd(result.addressableWaste)} (${wastePct.toFixed(1)}%)`
    )}`
  );
  lines.push("");

  if (result.findings.length === 0) {
    lines.push(c(GREEN, "No significant waste patterns detected. Either your setup is tight or the data lacks the fields analyzers need (hashes, sessions, timestamps)."));
  } else {
    const rows = result.findings.map((f, i) => {
      const savings = `${f.upper_bound ? "up to " : ""}$${Math.round(f.projected_monthly_savings_usd)}/mo`;
      return [
        String(i + 1),
        f.analyzer_name,
        usd(f.wasted_usd),
        `${(f.pct_of_total * 100).toFixed(1)}%`,
        savings,
        cap(f.confidence),
      ];
    });
    const headers = ["#", "Cause", "Waste", "% of spend", "Monthly savings", "Confidence"];
    const widths = headers.map((h, col) => Math.max(h.length, ...rows.map((r) => r[col]!.length)));
    const fmtRow = (cells: string[], colorize = false) =>
      " " +
      cells
        .map((cell, col) => {
          const padded = col === 0 || col >= 2 ? cell.padStart(widths[col]!) : cell.padEnd(widths[col]!);
          if (colorize && col === 5) return confColor(cell.toLowerCase()) + padded + (color ? RESET : "");
          return padded;
        })
        .join("   ");
    lines.push(c(DIM, fmtRow(headers)));
    for (const row of rows) lines.push(fmtRow(row, color));
  }

  for (const w of result.warnings) {
    lines.push("");
    lines.push(c(YELLOW, `${w.code}: ${w.message}`));
  }
  if (result.skippedAnalyzers.length > 0 && !result.warnings.some((w) => w.code === "W-202")) {
    lines.push("");
    lines.push(c(DIM, `Skipped analyzers (timestamps unusable): ${result.skippedAnalyzers.join(", ")}`));
  }

  if (result.unverifiedPricing.length > 0) {
    lines.push("");
    lines.push(
      c(
        DIM,
        `Pricing note: bundled prices for ${result.unverifiedPricing.join(", ")} are UNVERIFIED placeholders — verify or override before relying on $ figures.`
      )
    );
  }

  if (reportPath) {
    lines.push("");
    lines.push(`Report written: ${c(CYAN, reportPath)}`);
  }
  return lines.join("\n");
}

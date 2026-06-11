import type { AnalysisResult } from "../core/engine.js";
import type { Finding } from "../analyzers/types.js";

/**
 * Single self-contained HTML report: inline CSS/JS, hand-rolled SVG charts,
 * no CDN, opens offline. Never includes prompt bodies — only hashes, counts
 * and dollar figures.
 */
export function renderHtml(result: AnalysisResult, narrative: string | null = null): string {
  const wastePct = result.totalSpend > 0 ? (result.addressableWaste / result.totalSpend) * 100 : 0;
  const monthlySavings = result.findings.reduce((a, f) => a + f.projected_monthly_savings_usd, 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TokenTriage report · ${esc(result.periodStart)} – ${esc(result.periodEnd)}</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--panel2:#1c2330;--border:#2d333b;--text:#e6edf3;--dim:#8b949e;
--accent:#4ade80;--warn:#fbbf24;--bad:#f87171;--blue:#60a5fa;--purple:#c084fc;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:32px 16px}
.wrap{max-width:980px;margin:0 auto}
a{color:var(--blue)}
.hero{background:linear-gradient(135deg,#1a2332 0%,#10161f 100%);border:1px solid var(--border);border-radius:16px;padding:32px;margin-bottom:24px}
.hero h1{font-size:20px;font-weight:600;letter-spacing:.3px}
.hero h1 .logo{color:var(--accent)}
.hero .sub{color:var(--dim);margin-top:4px;font-size:14px}
.stats{display:flex;flex-wrap:wrap;gap:32px;margin-top:24px}
.stat .v{font-size:30px;font-weight:700;font-variant-numeric:tabular-nums}
.stat .l{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.8px;margin-top:2px}
.stat.big .v{font-size:42px;color:var(--accent)}
.stat .v.waste{color:var(--bad)}
.banner{background:#3a2e10;border:1px solid #6b5618;color:var(--warn);border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:14px}
.narrative{background:var(--panel);border:1px solid var(--border);border-left:3px solid var(--purple);border-radius:12px;padding:20px 24px;margin-bottom:24px;color:#d2dae3}
.narrative h2{font-size:13px;color:var(--purple);text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px}
.narrative p{margin-bottom:10px}
h2.sec{font-size:17px;margin:32px 0 14px;font-weight:600}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:20px 24px;margin-bottom:14px}
.card .head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.card .rank{color:var(--dim);font-weight:700}
.card .name{font-size:16px;font-weight:600}
.card .amount{font-variant-numeric:tabular-nums;font-weight:700;color:var(--bad)}
.badge{font-size:11px;padding:2px 9px;border-radius:99px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.badge.high{background:#11321f;color:var(--accent);border:1px solid #1d5733}
.badge.medium{background:#33290f;color:var(--warn);border:1px solid #6b5618}
.badge.low{background:#262c36;color:var(--dim);border:1px solid var(--border)}
.bar{height:8px;background:var(--panel2);border-radius:99px;margin:12px 0;overflow:hidden}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--bad),#fb923c);border-radius:99px}
.meta{color:var(--dim);font-size:13px}
.meta b{color:var(--text)}
.evidence{margin:14px 0 0;padding:0;list-style:none}
.evidence li{padding:8px 0;border-top:1px solid var(--border);font-size:13.5px;color:#c3ccd6}
.evidence li .el{color:var(--dim);margin-right:8px}
.evidence code{background:var(--panel2);padding:1px 6px;border-radius:5px;font-size:12.5px}
details.fix{margin-top:14px;border:1px solid var(--border);border-radius:10px;background:var(--panel2)}
details.fix summary{cursor:pointer;padding:10px 16px;font-weight:600;font-size:14px;color:var(--accent)}
details.fix .fixbody{padding:4px 16px 16px}
details.fix ol{margin:8px 0 12px 20px;font-size:14px;color:#c3ccd6}
details.fix ol li{margin-bottom:5px}
.snippet{position:relative;background:#0a0e14;border:1px solid var(--border);border-radius:8px;margin-top:6px}
.snippet pre{padding:14px 16px;overflow-x:auto;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#d6e2f0}
.snippet button{position:absolute;top:8px;right:8px;background:var(--panel);border:1px solid var(--border);color:var(--dim);font-size:11px;padding:4px 10px;border-radius:6px;cursor:pointer}
.snippet button:hover{color:var(--text);border-color:var(--dim)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:760px){.grid{grid-template-columns:1fr}.stats{gap:20px}}
.chart-title{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.7px;margin-bottom:10px}
svg text{font:11px -apple-system,"Segoe UI",sans-serif;fill:var(--dim)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;color:var(--dim);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.5px;padding:8px 10px;border-bottom:1px solid var(--border)}
td{padding:8px 10px;border-bottom:1px solid var(--panel2);font-variant-numeric:tabular-nums}
td.num,th.num{text-align:right}
.legend{display:flex;flex-direction:column;gap:6px;font-size:13px}
.legend .row{display:flex;align-items:center;gap:8px}
.legend .sw{width:10px;height:10px;border-radius:3px;flex:none}
.legend .m{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.legend .v{color:var(--dim)}
.foot{color:var(--dim);font-size:12.5px;margin-top:36px;border-top:1px solid var(--border);padding-top:16px}
.foot p{margin-bottom:6px}
.donutwrap{display:flex;gap:20px;align-items:center}
</style>
</head>
<body><div class="wrap">

<div class="hero">
  <h1><span class="logo">▲</span> TokenTriage <span style="color:var(--dim);font-weight:400">· why your bill is high</span></h1>
  <div class="sub">${esc(result.periodStart)} → ${esc(result.periodEnd)} · ${result.daysInDataset} days · ${result.requestCount.toLocaleString()} requests</div>
  <div class="stats">
    <div class="stat"><div class="v">${usd(result.totalSpend)}</div><div class="l">Total spend</div></div>
    <div class="stat"><div class="v waste">${usd(result.addressableWaste)}</div><div class="l">Addressable waste (${wastePct.toFixed(1)}%)</div></div>
    <div class="stat big"><div class="v">~${usd(monthlySavings, 0)}/mo</div><div class="l">Potential monthly savings</div></div>
  </div>
</div>

${result.smallSample ? `<div class="banner">⚠ Small sample (N=${result.requestCount}). Findings are directional, not conclusive.</div>` : ""}
${result.warnings.map((w) => `<div class="banner">${esc(w.code)}: ${esc(w.message)}</div>`).join("\n")}

${narrative ? `<div class="narrative"><h2>Executive summary</h2>${narrative.split(/\n\n+/).map((p) => `<p>${esc(p.trim())}</p>`).join("")}</div>` : ""}

<h2 class="sec">Why your bill is high</h2>
${result.findings.length === 0 ? `<div class="card meta">No significant waste patterns detected in this dataset.</div>` : result.findings.map((f, i) => findingCard(f, i, result)).join("\n")}

<h2 class="sec">Spend overview</h2>
<div class="card">
  <div class="chart-title">Daily spend (USD)</div>
  ${dailySpendSvg(result)}
</div>
<div class="grid">
  <div class="card">
    <div class="chart-title">Model mix (by spend)</div>
    ${modelDonut(result)}
  </div>
  <div class="card">
    <div class="chart-title">Input vs output spend</div>
    ${ioSplit(result)}
  </div>
</div>

${worstSessions(result)}

<div class="foot">
  ${result.unpricedModels.length > 0 ? `<p><b>Unpriced models</b> (costed at $0): ${esc(result.unpricedModels.join(", "))}. Add them to <code>~/.tokentriage/pricing.override.json</code>.</p>` : ""}
  ${result.sessionInferenceUsed ? `<p><b>Session inference:</b> some sessions were reconstructed heuristically (same system prompt hash, growing input, &lt;30 min gaps). Parallel sessions with identical system prompts may merge. Disable with <code>--no-session-inference</code>.</p>` : ""}
  ${result.skippedAnalyzers.length > 0 ? `<p><b>Skipped analyzers:</b> ${esc(result.skippedAnalyzers.join(", "))}.</p>` : ""}
  <p><b>Methodology:</b> all figures are estimates. Percentages are of total spend; "addressable waste" is the sum of findings, separate from base spend. Monthly projections extrapolate the ${result.daysInDataset}-day period to 30 days. Every threshold and formula is documented in <a href="https://github.com/abhinavagg810/token_triage/blob/main/src/analyzers/THRESHOLDS.md">THRESHOLDS.md</a>. A claimed-token ledger guarantees no token is counted by two analyzers.</p>
  ${result.pricingLastVerified ? `<p><b>Pricing</b> last verified ${esc(result.pricingLastVerified)}. Override at <code>~/.tokentriage/pricing.override.json</code>.</p>` : ""}
  <p>Generated locally by <b>TokenTriage</b> — no data left this machine.</p>
</div>

</div>
<script>
function copySnippet(btn){
  var pre = btn.parentElement.querySelector('pre');
  var done = function(){ btn.textContent='Copied ✓'; setTimeout(function(){btn.textContent='Copy';},1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(pre.textContent).then(done);
  } else {
    var r=document.createRange(); r.selectNodeContents(pre);
    var s=getSelection(); s.removeAllRanges(); s.addRange(r);
    document.execCommand('copy'); s.removeAllRanges(); done();
  }
}
</script>
</body></html>`;
}

function findingCard(f: Finding, index: number, result: AnalysisResult): string {
  const pct = (f.pct_of_total * 100).toFixed(1);
  const barWidth = Math.min(100, f.pct_of_total * 100 * 2); // 50% of spend = full bar
  const savings = `${f.upper_bound ? "up to " : "~"}${usd(f.projected_monthly_savings_usd, 0)}/month`;
  return `<div class="card">
  <div class="head">
    <span class="rank">#${index + 1}</span>
    <span class="name">${esc(f.analyzer_name)}</span>
    <span class="amount">${usd(f.wasted_usd)}</span>
    <span class="meta">${pct}% of ${usd(result.totalSpend, 0)} spend</span>
    <span class="badge ${f.confidence}">${f.confidence}</span>
  </div>
  <div class="bar"><i style="width:${barWidth.toFixed(1)}%"></i></div>
  <div class="meta">Projected savings: <b>${savings}</b> <span style="opacity:.7">(extrapolated from ${result.daysInDataset} days)</span></div>
  <ul class="evidence">
    ${f.evidence.map((e) => `<li><span class="el">${esc(e.label)}</span>${inlineCode(esc(e.detail))}</li>`).join("\n    ")}
  </ul>
  <details class="fix">
    <summary>Show fix ▾</summary>
    <div class="fixbody">
      <p class="meta" style="color:#c3ccd6">${esc(f.fix.summary)}</p>
      <ol>${f.fix.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
      ${f.fix.snippet ? `<div class="snippet"><button onclick="copySnippet(this)">Copy</button><pre>${esc(f.fix.snippet)}</pre></div>` : ""}
      ${f.fix.docs_url ? `<p style="margin-top:10px;font-size:13px"><a href="${esc(f.fix.docs_url)}">Provider docs →</a></p>` : ""}
    </div>
  </details>
</div>`;
}

function dailySpendSvg(result: AnalysisResult): string {
  const data = result.dailySpend;
  if (data.length === 0) return `<div class="meta">No dated records.</div>`;
  const W = 880;
  const H = 180;
  const padL = 46;
  const padB = 22;
  const padT = 10;
  const max = Math.max(...data.map((d) => d.usd), 0.01);
  const x = (i: number) => padL + (i / Math.max(1, data.length - 1)) * (W - padL - 10);
  const y = (v: number) => padT + (1 - v / max) * (H - padT - padB);
  const points = data.map((d, i) => `${x(i).toFixed(1)},${y(d.usd).toFixed(1)}`).join(" ");
  const area = `${padL},${y(0).toFixed(1)} ${points} ${x(data.length - 1).toFixed(1)},${y(0).toFixed(1)}`;
  const ticks = [0, 0.5, 1].map((f) => {
    const v = max * f;
    return `<line x1="${padL}" y1="${y(v)}" x2="${W - 10}" y2="${y(v)}" stroke="#2d333b" stroke-width="1" stroke-dasharray="3,4"/>
<text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">$${v >= 10 ? v.toFixed(0) : v.toFixed(1)}</text>`;
  });
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));
  const labels = data
    .map((d, i) =>
      i % labelEvery === 0 ? `<text x="${x(i)}" y="${H - 4}" text-anchor="middle">${d.date.slice(5)}</text>` : ""
    )
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Daily spend">
${ticks.join("\n")}
<polygon points="${area}" fill="#60a5fa" opacity="0.12"/>
<polyline points="${points}" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linejoin="round"/>
${labels}
</svg>`;
}

const DONUT_COLORS = ["#60a5fa", "#4ade80", "#fbbf24", "#f87171", "#c084fc", "#22d3ee", "#fb923c", "#a3e635"];

function modelDonut(result: AnalysisResult): string {
  const total = result.modelSpend.reduce((a, m) => a + m.usd, 0);
  if (total <= 0) return `<div class="meta">No priced spend.</div>`;
  const top = result.modelSpend.slice(0, 7);
  const other = result.modelSpend.slice(7).reduce((a, m) => a + m.usd, 0);
  const slices = [...top.map((m) => ({ label: m.model, usd: m.usd })), ...(other > 0 ? [{ label: "other", usd: other }] : [])];
  const R = 54;
  const CX = 70;
  const CY = 70;
  let angle = -Math.PI / 2;
  const paths = slices.map((s, i) => {
    const frac = s.usd / total;
    const a2 = angle + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = CX + R * Math.cos(angle);
    const y1 = CY + R * Math.sin(angle);
    const x2 = CX + R * Math.cos(a2 - 0.004);
    const y2 = CY + R * Math.sin(a2 - 0.004);
    angle = a2;
    if (frac >= 0.999) {
      return `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${DONUT_COLORS[i % DONUT_COLORS.length]}" stroke-width="22"/>`;
    }
    return `<path d="M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}" fill="none" stroke="${DONUT_COLORS[i % DONUT_COLORS.length]}" stroke-width="22"/>`;
  });
  const legend = slices
    .map(
      (s, i) =>
        `<div class="row"><span class="sw" style="background:${DONUT_COLORS[i % DONUT_COLORS.length]}"></span><span class="m">${esc(s.label)}</span><span class="v">${((s.usd / total) * 100).toFixed(1)}% · ${usd(s.usd, 0)}</span></div>`
    )
    .join("");
  return `<div class="donutwrap"><svg viewBox="0 0 140 140" width="140" height="140">${paths.join("")}</svg><div class="legend">${legend}</div></div>`;
}

function ioSplit(result: AnalysisResult): string {
  const total = result.inputCost + result.outputCost + result.cacheCost;
  if (total <= 0) return `<div class="meta">No priced spend.</div>`;
  const rows = [
    { label: "Input tokens", usd: result.inputCost, color: "#60a5fa" },
    { label: "Output tokens", usd: result.outputCost, color: "#f87171" },
    ...(result.cacheCost > 0.005 ? [{ label: "Cache reads/writes", usd: result.cacheCost, color: "#4ade80" }] : []),
  ];
  return rows
    .map((r) => {
      const pct = (r.usd / total) * 100;
      return `<div style="margin-bottom:12px">
<div style="display:flex;justify-content:space-between;font-size:13px"><span>${r.label}</span><span class="meta">${usd(r.usd)} · ${pct.toFixed(1)}%</span></div>
<div class="bar" style="margin:6px 0 0"><i style="width:${pct.toFixed(1)}%;background:${r.color}"></i></div>
</div>`;
    })
    .join("");
}

function worstSessions(result: AnalysisResult): string {
  const bloat = result.findings.find((f) => f.analyzer_id === "context-bloat");
  const sessions = (bloat?.details?.worst_sessions ?? []) as {
    id: string;
    turns: number;
    first_input: number;
    last_input: number;
    wasted_usd: number;
    growth: number[];
  }[];
  if (sessions.length === 0) return "";
  const rows = sessions
    .slice(0, 10)
    .map(
      (s) => `<tr>
<td><code>${esc(s.id)}</code></td>
<td class="num">${s.turns}</td>
<td class="num">${s.first_input.toLocaleString()} → ${s.last_input.toLocaleString()}</td>
<td>${sparkline(s.growth)}</td>
<td class="num" style="color:var(--bad)">${usd(s.wasted_usd)}</td>
</tr>`
    )
    .join("\n");
  return `<h2 class="sec">Worst sessions by waste</h2>
<div class="card">
<table>
<thead><tr><th>Session</th><th class="num">Turns</th><th class="num">Input growth (tokens)</th><th>Curve</th><th class="num">Waste</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;
}

function sparkline(values: number[]): string {
  if (values.length < 2) return "";
  const W = 110;
  const H = 24;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = Math.max(1, max - min);
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * (W - 4) + 2).toFixed(1)},${(H - 3 - ((v - min) / range) * (H - 6)).toFixed(1)}`)
    .join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><polyline points="${pts}" fill="none" stroke="#fb923c" stroke-width="1.5"/></svg>`;
}

function usd(n: number, decimals = 2): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Render `backticked` spans in evidence text as <code> (input already escaped). */
function inlineCode(s: string): string {
  return s.replace(/`([^`]+)`/g, "<code>$1</code>");
}
